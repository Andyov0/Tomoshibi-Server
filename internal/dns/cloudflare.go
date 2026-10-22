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
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Cloudflare creates and removes A records in one zone.
type Cloudflare struct {
	token  string
	zoneID string
	client *http.Client
}

// NewCloudflare builds one.
func NewCloudflare(token, zoneID string) *Cloudflare {
	return &Cloudflare{
		token:  token,
		zoneID: zoneID,
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

// Configured reports whether there is anything to talk to.
func (c *Cloudflare) Configured() bool {
	return c != nil && c.token != "" && c.zoneID != ""
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
	existing, err := c.find(host)
	if err != nil {
		return err
	}

	record := cfRecord{
		Type: "A", Name: host, Content: addr, TTL: 300, Proxied: false,
		Comment: "Tomoshibi relay. Media reaches it directly.",
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

// Unpoint removes every A record for host.
//
// Called when a relay is dropped. A zone that accumulates names for machines
// that are gone is one where the next person cannot tell which names are real.
func (c *Cloudflare) Unpoint(host string) error {
	existing, err := c.find(host)
	if err != nil {
		return err
	}

	for _, record := range existing {
		if err := c.call(http.MethodDelete, "dns_records/"+record.ID, nil); err != nil {
			return err
		}
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
	return "https://api.cloudflare.com/client/v4/zones/" + c.zoneID + "/" + path
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
