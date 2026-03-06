# Build the Go backend for SyncMusic
FROM golang:1.26-alpine

# Install build tools for sqlite 
RUN apk add --no-cache gcc musl-dev

# Set working directory inside the container
WORKDIR /app

# Copy the go mod files first to leverage Docker layer caching
COPY go.mod go.sum ./
RUN go mod download

# Copy all source files
COPY *.go ./

# Compile the binary
RUN CGO_ENABLED=0 go build -o server .

# Start the server
CMD ["./server"]