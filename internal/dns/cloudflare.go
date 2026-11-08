// Package dns points a relay's name at the machine serving it.
//
// A relay is reached by name and the name has to exist before anybody can use
// it. Leaving that to whoever ran the install script means an install that
// looks finished and produces a relay the pages show as unreachable — which is
// indistinguishable, on the page, from a machine that is down.
//
// The machine cannot do it for itself: creating a record needs credentials to
// the whole zone, and those belong on the control node rather than on every
// relay that will ever be added.
package dns

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

/*
Only this deployment's records, and only under its own domain.

The token is for the whole zone, which on this deployment is a zone shared with
other services, and the two writes here used to act on whatever they found. An
enrolment PATCHed the first A record with the relay's name and deleted the
rest, whoever had made them; removing a relay deleted every A record for the
host in its stored address, and that address could be anything somebody typed
into the relays page. So a relay named after an existing service took that
service's name over, and adding a "relay" whose address was another service's
name and then removing it deleted that service's record.

Now both writes stay inside one subtree — a single label under enrol.domain —
never touch the control node's own names, and touch only records that carry the
comment this code has always written on the records it creates. A record
without it is somebody else's: the write is refused and the record left alone,
and the log says so. A record made by hand for an older relay can be handed
over by giving it that comment.
*/

// Marker is how every record this deployment creates begins its comment.
const Marker = "Tomoshibi relay."

// ErrNotOurs is a record this deployment did not create, at a name it was
// asked to write or remove.
var ErrNotOurs = errors.New("a record there was not created by this deployment")

// ErrOutsideDomain is a name this deployment does not write: not a single label
// under the enrolment domain, or one of the control node's own names.
var ErrOutsideDomain = errors.New("not a name this deployment writes")

// Cloudflare creates and removes A records in one zone.
type Cloudflare struct {
	token  string
	zoneID string
	client *http.Client

	// domain is the subtree written in; empty writes nowhere.
	domain string
	// keep are names never written or removed, whatever else holds.
	keep map[string]bool
	// base is the API, replaceable so a test can stand in for it.
	base string
}

// NewCloudflare builds one.
func NewCloudflare(token, zoneID string) *Cloudflare {
	return &Cloudflare{
		token:  token,
		zoneID: zoneID,
		client: &http.Client{Timeout: 20 * time.Second},
		base:   "https://api.cloudflare.com/client/v4",
		keep:   map[string]bool{},
	}
}

// Within says where it may write: single labels under domain, and none of
// keep.
func (c *Cloudflare) Within(domain string, keep ...string) *Cloudflare {
	c.domain = normal(domain)

	for _, host := range keep {
		if host = normal(host); host != "" {
			c.keep[host] = true
		}
	}

	return c
}

// Configured reports whether there is anything to talk to.
func (c *Cloudflare) Configured() bool {
	return c != nil && c.token != "" && c.zoneID != ""
}

func normal(host string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(host), "."))
}

// mayWrite refuses a name outside the subtree or among the kept ones.
func (c *Cloudflare) mayWrite(host string) error {
	host = normal(host)

	label, found := strings.CutSuffix(host, "."+c.domain)
	if c.domain == "" || !found || label == "" || strings.Contains(label, ".") || c.keep[host] {
		return fmt.Errorf("%w: %s (writes only single labels under %q)", ErrOutsideDomain, host, c.domain)
	}

	return nil
}

// ours reports whether a record carries the comment this deployment writes.
func ours(record cfRecord) bool {
	return strings.HasPrefix(record.Comment, Marker)
}

// Clashes reports whether an enrolment domain would let a prefix name the
// control node itself: the domain is the control node's own name, or the one
// directly above it.
//
// Refused rather than guarded name by name. With `meet.example.com` serving the
// pages and enrolment under `example.com`, the prefix `meet` is the control
// node, the wildcard covers it, and whoever can enrol a relay can point the
// deployment's own address at their machine.
func Clashes(domain, control string) bool {
	domain, control = normal(domain), normal(control)
	if domain == "" || control == "" {
		return false
	}

	if domain == control {
		return true
	}

	_, parent, found := strings.Cut(control, ".")

	return found && parent == domain
}

type cfRecord struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	// Proxied is always false for a relay, and this is not a default worth
	// changing. Media has to reach the machine directly: proxying it would put
	// a CDN on the media path — the one thing splitting the deployment was
	// meant to keep off it — and a proxy that terminates TLS cannot carry
	// WebRTC at all.
	Proxied bool   `json:"proxied"`
	Comment string `json:"comment,omitempty"`
}

type cfReply struct {
	Success bool       `json:"success"`
	Errors  []cfError  `json:"errors"`
	Result  []cfRecord `json:"result"`
}

type cfError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e cfError) String() string { return fmt.Sprintf("%d %s", e.Code, e.Message) }

// Point makes host resolve to addr.
//
// Replaces whatever A record is there rather than adding beside it. Two A
// records for one relay would send half its clients to a machine that is not
// it — which is the shape of fault that takes a day to find, because it works
// for whoever tests it first.
func (c *Cloudflare) Point(host, addr string) error {
	if err := c.mayWrite(host); err != nil {
		return err
	}

	existing, err := c.find(host)
	if err != nil {
		return err
	}

	for _, record := range existing {
		if !ours(record) {
			return fmt.Errorf("%w: %s already has an A record (%s) whose comment does not begin %q; "+
				"remove it, or give it that comment to hand it to this deployment",
				ErrNotOurs, host, record.Content, Marker)
		}
	}

	record := cfRecord{
		Type: "A", Name: host, Content: addr, TTL: 300, Proxied: false,
		Comment: Marker + " Media reaches it directly.",
	}

	if len(existing) == 0 {
		return c.call(http.MethodPost, "dns_records", record)
	}

	// The first is updated and any others removed, so a zone that already had
	// two ends with one.
	if err := c.call(http.MethodPatch, "dns_records/"+existing[0].ID, record); err != nil {
		return err
	}

	for _, extra := range existing[1:] {
		if err := c.call(http.MethodDelete, "dns_records/"+extra.ID, nil); err != nil {
			return err
		}
	}

	return nil
}

// Answers reports whether the name resolves to the address, by asking rather
// than by trusting the write.
//
// A zone accepting a record is not the same as the internet returning it, and
// the ways they come apart are quiet ones: the name may sit under a CNAME that
// shadows it, the zone may not be the one serving that subtree, or somebody may
// have written the same name somewhere with higher precedence. Every one of
// those ends with an API call that succeeded, a log line saying the name was
// created, and a machine nobody can reach by it.
//
// Not called by Point, deliberately. A new record takes time to be visible and
// a check inside the write would fail on the ordinary case; this is for the
// caller who has somewhere to report the answer and can wait.
func Answers(host, addr string) (bool, error) {
	found, err := net.LookupHost(host)
	if err != nil {
		return false, err
	}

	for _, one := range found {
		if one == addr {
			return true, nil
		}
	}

	return false, nil
}

// Unpoint removes the A records this deployment made for host.
//
// Called when a relay is dropped. A zone that accumulates names for machines
// that are gone is one where the next person cannot tell which names are real.
// Records somebody else made at the same name are left, and said.
func (c *Cloudflare) Unpoint(host string) error {
	if err := c.mayWrite(host); err != nil {
		return err
	}

	existing, err := c.find(host)
	if err != nil {
		return err
	}

	foreign := 0

	for _, record := range existing {
		if !ours(record) {
			foreign++
			continue
		}

		if err := c.call(http.MethodDelete, "dns_records/"+record.ID, nil); err != nil {
			return err
		}
	}

	if foreign > 0 {
		return fmt.Errorf("%w: %d A record(s) at %s were left in place", ErrNotOurs, foreign, host)
	}

	return nil
}

// find returns the A records for a name.
func (c *Cloudflare) find(host string) ([]cfRecord, error) {
	query := url.Values{}
	query.Set("type", "A")
	query.Set("name", strings.TrimSuffix(host, "."))

	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		c.endpoint("dns_records?"+query.Encode()), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.token)

	response, err := c.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("ask cloudflare for %s: %w", host, err)
	}
	defer response.Body.Close()

	var reply cfReply
	if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
		return nil, fmt.Errorf("read cloudflare's answer for %s: %w", host, err)
	}

	if !reply.Success {
		return nil, fmt.Errorf("cloudflare refused to list %s: %s", host, problem(reply.Errors))
	}

	return reply.Result, nil
}

// call runs one write against the zone.
func (c *Cloudflare) call(method, path string, body any) error {
	var payload []byte

	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = encoded
	}

	request, err := http.NewRequestWithContext(context.Background(), method,
		c.endpoint(path), bytes.NewReader(payload))
	if err != nil {
		return err
	}

	request.Header.Set("Authorization", "Bearer "+c.token)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer response.Body.Close()

	// Decoded into the same shape for every verb: Cloudflare answers a single
	// record as an object and a list as an array, and only the success flag and
	// the errors are read here.
	var reply struct {
		Success bool      `json:"success"`
		Errors  []cfError `json:"errors"`
	}

	if err := json.NewDecoder(response.Body).Decode(&reply); err != nil {
		return fmt.Errorf("read cloudflare's answer to %s %s: %w", method, path, err)
	}

	if !reply.Success {
		return fmt.Errorf("cloudflare refused %s %s: %s", method, path, problem(reply.Errors))
	}

	return nil
}

func (c *Cloudflare) endpoint(path string) string {
	return c.base + "/zones/" + c.zoneID + "/" + path
}

// problem turns Cloudflare's error list into one sentence.
//
// Named rather than summarised, because the codes are the useful half: 10000 is
// a token without the permission, 9109 a zone that is not this account's, and
// knowing which turns a broken deployment into a setting to change.
func problem(errs []cfError) string {
	if len(errs) == 0 {
		return "no reason given"
	}

	parts := make([]string, 0, len(errs))
	for _, e := range errs {
		parts = append(parts, e.String())
	}

	return strings.Join(parts, "; ")
}
