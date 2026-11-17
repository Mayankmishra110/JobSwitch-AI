// Package events is the matcher's D-26 event bus publisher - NATS core
// pub/sub (not JetStream persistence), since the SSE bridge's actual need
// is live push to a currently-connected browser tab, not durable replay
// to a consumer that connects later. JetStream stays available on the
// same server for whatever future event genuinely needs durability
// (docker-compose/k8s both run it with -js already).
//
// Mirrors apps/web/src/services/events.ts's own shape: same subject
// convention (account.<accountId>.<event>), same "best-effort, never
// fail the caller's real work over a bus hiccup" philosophy.
package events

import (
	"encoding/json"
	"fmt"

	"github.com/nats-io/nats.go"
)

// MatchComputed is the one event this service publishes today - see
// specs/events-and-realtime.md for the rest of D-26's catalog and which
// entries are wired vs. reserved.
const MatchComputed = "match.computed"

type MatchComputedPayload struct {
	AccountID      string `json:"accountId"`
	MatchesWritten int    `json:"matchesWritten"`
}

func AccountSubject(accountID, event string) string {
	return fmt.Sprintf("account.%s.%s", accountID, event)
}

// Publisher wraps one NATS connection. Optional everywhere it's used -
// internal/match.RunForAccount accepts a nil *Publisher and simply skips
// publishing, so every existing test that never cared about the event bus
// keeps working without needing a running NATS server.
type Publisher struct {
	nc *nats.Conn
}

func Connect(url string) (*Publisher, error) {
	nc, err := nats.Connect(url)
	if err != nil {
		return nil, fmt.Errorf("connecting to NATS at %s: %w", url, err)
	}
	return &Publisher{nc: nc}, nil
}

// Publish is a no-op on a nil *Publisher - see the type's own doc comment
// for why that is deliberate, not a missing nil check.
func (p *Publisher) Publish(accountID, event string, payload any) error {
	if p == nil {
		return nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshaling %s payload: %w", event, err)
	}
	if err := p.nc.Publish(AccountSubject(accountID, event), data); err != nil {
		return fmt.Errorf("publishing %s for %s: %w", event, accountID, err)
	}
	return nil
}

func (p *Publisher) Close() {
	if p == nil {
		return
	}
	p.nc.Close()
}
