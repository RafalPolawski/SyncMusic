package hub

import (
	"encoding/json"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/RafalPolawski/SyncMusic/internal/room"
)

// Metrics holds the hub's Prometheus collectors. A nil *Metrics is valid and
// records nothing.
type Metrics struct {
	Connections prometheus.Gauge
	Rooms       prometheus.Gauge
	Commands    *prometheus.CounterVec
}

// NewMetrics creates and registers the hub collectors.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Connections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "syncmusic_connections", Help: "Open WebSocket connections.",
		}),
		Rooms: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "syncmusic_rooms", Help: "Rooms loaded in memory.",
		}),
		Commands: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "syncmusic_commands_total", Help: "Applied room commands by operation.",
		}, []string{"op"}),
	}
	reg.MustRegister(m.Connections, m.Rooms, m.Commands)
	return m
}

func (m *Metrics) connected(delta float64) {
	if m != nil {
		m.Connections.Add(delta)
	}
}

func (m *Metrics) rooms(n int) {
	if m != nil {
		m.Rooms.Set(float64(n))
	}
}

func (m *Metrics) command(op string) {
	if m != nil {
		m.Commands.WithLabelValues(op).Inc()
	}
}

func unmarshalState(b []byte, st *room.State) error {
	return json.Unmarshal(b, st)
}
