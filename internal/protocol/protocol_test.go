package protocol

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDecode(t *testing.T) {
	cases := []struct {
		in   string
		want any
	}{
		{`{"type":"hello","protocol":1,"clientId":"abc","name":"Ala","room":"gym"}`, &Hello{}},
		{`{"type":"ping","id":3,"t0":1.5}`, &Ping{}},
		{`{"type":"cmd","id":"c1","cmd":{"op":"seek","positionMs":1000}}`, &Command{}},
		{`{"type":"status","trackId":"t","ready":true,"driftMs":-3.2}`, &Status{}},
		{`{"type":"profile","name":"Bob"}`, &Profile{}},
	}
	for _, c := range cases {
		got, err := Decode([]byte(c.in))
		if err != nil {
			t.Fatalf("%s: %v", c.in, err)
		}
		gb, _ := json.Marshal(got)
		var a, b map[string]any
		_ = json.Unmarshal(gb, &a)
		_ = json.Unmarshal([]byte(c.in), &b)
		if a["type"] != b["type"] {
			t.Fatalf("%s decoded to %T", c.in, got)
		}
	}
	cmd, _ := Decode([]byte(`{"type":"cmd","id":"c1","cmd":{"op":"seek","positionMs":1000}}`))
	if c := cmd.(*Command); c.Cmd.Op != "seek" || *c.Cmd.PositionMs != 1000 {
		t.Fatalf("command = %+v", c)
	}
}

func TestDecodeErrors(t *testing.T) {
	if _, err := Decode([]byte(`{"type":"weird"}`)); !errors.Is(err, ErrUnknownType) {
		t.Fatalf("unknown type: %v", err)
	}
	for _, bad := range []string{``, `[]`, `{"type":"ping","id":"not a number"}`, `{"type":"cmd","cmd":"x"}`} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Errorf("Decode(%q) should fail", bad)
		}
	}
}

func FuzzDecode(f *testing.F) {
	for _, s := range []string{
		`{"type":"hello","protocol":1}`, `{"type":"ping","id":1,"t0":2}`,
		`{"type":"cmd","id":"x","cmd":{"op":"queueAdd","trackIds":["a"]}}`, `{"type":"status"}`, `{}`, `null`,
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		msg, err := Decode(data)
		if err == nil && msg == nil {
			t.Fatal("nil message without error")
		}
	})
}
