// Package httpx holds small HTTP helpers shared across the matcher's
// handlers - JSON responses and the auth middleware. Deliberately built on
// net/http (Go 1.22+'s ServeMux already supports "METHOD /path" patterns)
// rather than a router library: the route count here does not yet justify
// one, and adding a dependency that doesn't earn its place is exactly the
// kind of call this whole project tries to make deliberately, not by habit.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

func JSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Error("encoding JSON response", "err", err)
	}
}

// ErrorBody mirrors packages/core/src/errors.ts's HTTP error shape:
// {error: code, message: safeMessage} - so a client (or a human comparing
// the two services in a browser devtools tab) sees the same envelope
// regardless of which service answered.
type ErrorBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

func Unauthenticated(w http.ResponseWriter) {
	JSON(w, http.StatusUnauthorized, ErrorBody{
		Error:   "unauthenticated",
		Message: "Please sign in to continue.",
	})
}

func Internal(w http.ResponseWriter) {
	JSON(w, http.StatusInternalServerError, ErrorBody{
		Error:   "internal",
		Message: "Something went wrong on our end.",
	})
}
