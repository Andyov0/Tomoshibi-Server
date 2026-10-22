package config

import (
	"reflect"
	"strings"
	"testing"

	livekit "github.com/livekit/livekit-server/pkg/config"
)

/*
How a relay decides what each viewer is sent, and whether the file says what the
process does.

Two settings under `rtc` change that: `congestion_control.use_send_side_bwe`,
which has the media server choose each viewer's layer from the browser's own
transport-wide feedback, and `packet_buffer_size_video`, how many packets of
video it keeps for resending. Measured before they were chosen: on the defaults
a viewer whose line could not carry a full-size screen share was sent all of it
anyway and saw no frame for a minute, and a sharer behind a tunnel lost packets
the relay had already forgotten.

Every way of getting them wrong is silent. The process starts, calls connect,
cameras play, and the difference shows only when somebody shares a screen over
a line that cannot carry the whole of it. So these tests hold three things:

  - The example a relay is configured from carries both, at the right depth.
  - Naming one setting under `congestion_control` leaves the rest of that
    section at the media server's defaults. The media server decodes the file
    onto its defaults rather than onto nothing, and if that ever stopped being
    true, writing only the one key would take congestion control off
    altogether: every viewer sent the largest layer it asked for whatever its
    line can carry, which is the freeze above with nothing left to end it.
  - A misspelling, or the right key at the wrong depth, stops the process
    rather than being ignored. The loader asks the media server for strictness;
    asked for leniency, a relay with `use_sendside_bwe` would run the old
    estimate for ever with a file that appears to say otherwise.
*/

const someKey = "keys:\n  APItest: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"

// The defaults the media server would have used, with the one change asked for.
func withSenderSide() livekit.CongestionControlConfig {
	want := livekit.DefaultConfig.RTC.CongestionControl
	want.Enabled = true
	want.UseSendSideBWE = true
	return want
}

func TestTheExampleRelayChoosesFromTheSendersEstimate(t *testing.T) {
	// The file RELAY.md points at, read as a relay would read it. A test copy of
	// it here would pass while the example itself went stale.
	conf, err := Load("../../dev/relay.yaml")
	if err != nil {
		t.Fatalf("the example relay configuration does not load: %v", err)
	}

	if conf.Meet.Role != RoleRelay {
		t.Fatalf("the example relay configuration is a %q", conf.Meet.Role)
	}

	rtc := conf.LiveKit.RTC

	if got, want := rtc.CongestionControl, withSenderSide(); !reflect.DeepEqual(got, want) {
		t.Errorf("the example relay's congestion control is\n  %+v\nwant the media server's "+
			"defaults with the sender-side estimate on:\n  %+v", got, want)
	}

	if rtc.PacketBufferSizeVideo != 4000 {
		t.Errorf("the example relay keeps %d packets of video for resending, want 4000; at 500 a "+
			"1440p share's history is a tenth of a second and a sharer behind a tunnel loses "+
			"packets the relay has already forgotten", rtc.PacketBufferSizeVideo)
	}

	// Audio is not what was measured and stays where the media server put it.
	if rtc.PacketBufferSizeAudio != livekit.DefaultConfig.RTC.PacketBufferSizeAudio {
		t.Errorf("the example relay changed the audio resend window to %d",
			rtc.PacketBufferSizeAudio)
	}
}

func TestNamingTheEstimateAloneLeavesTheRestAtTheDefaults(t *testing.T) {
	conf, err := Load(write(t, someKey+`
rtc:
  congestion_control:
    use_send_side_bwe: true
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	got := conf.LiveKit.RTC.CongestionControl

	if !got.Enabled {
		t.Fatal("naming only use_send_side_bwe took congestion control off: the media server " +
			"decoded the section onto nothing rather than onto its defaults, and every viewer " +
			"would be sent the largest layer it asked for whatever its line can carry")
	}

	// The pacer in particular is meant to be the default. It is the one key a
	// reader of the media server's documentation is most tempted to add, and
	// neither of the two it can select holds a packet back.
	if want := withSenderSide(); !reflect.DeepEqual(got, want) {
		t.Errorf("naming one key changed others:\n  got  %+v\n  want %+v", got, want)
	}
}

func TestAMisspeltMediaSettingStopsTheRelay(t *testing.T) {
	for _, tc := range []struct {
		name, body string
	}{
		{"a misspelt estimate", `
rtc:
  congestion_control:
    use_sendside_bwe: true
`},
		{"a misspelt window", `
rtc:
  packet_buffer_size_vidoe: 4000
`},
		{"the estimate one level too shallow", `
rtc:
  use_send_side_bwe: true
`},
		{"the window outside rtc", `
packet_buffer_size_video: 4000
`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(write(t, someKey+tc.body))
			if err == nil {
				t.Fatalf("this was accepted, so a relay would start on the defaults with a "+
					"file that says otherwise:%s", tc.body)
			}

			// Refused by the media server's half, which is where the message
			// names the key.
			if !strings.Contains(err.Error(), "media server configuration") {
				t.Errorf("refused, but not by the media server's strict reading: %v", err)
			}
		})
	}
}
