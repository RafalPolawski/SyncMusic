# Build the Go backend for SyncMusic
FROM golang:1.26-alpine

# Set working directory inside the container
WORKDIR /app

# Copy the single-file source
COPY main.go .

# Initialise the module and pull dependencies
RUN go mod init gym-sync
RUN go get github.com/quic-go/webtransport-go
RUN go get github.com/dhowden/tag

# Compile the binary
RUN go build -o server .

# Start the server
CMD ["./server"]