package api

import "testing"

func TestReadiness(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		want Status
	}{
		{"not enrolled", Config{}, StatusUnconfigured},
		{"enrolled no credential", Config{ControlPlaneURL: "https://cp.local/worker/v1"}, StatusDegraded},
		{"ready", Config{ControlPlaneURL: "https://cp.local/worker/v1", CredentialPresent: true}, StatusReady},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Readiness(tc.cfg).Status; got != tc.want {
				t.Fatalf("Readiness(%+v).Status = %q, want %q", tc.cfg, got, tc.want)
			}
		})
	}
}
