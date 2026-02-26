# Używamy oficjalnego obrazu z językiem Go (lekka wersja alpine)
FROM golang:1.26-alpine

# Ustawiamy katalog roboczy wewnątrz kontenera
WORKDIR /app

# Kopiujemy nasz kod źródłowy do kontenera
COPY main.go .

# Inicjalizujemy projekt Go i pobieramy bibliotekę do WebSocketów
RUN go mod init gym-sync
RUN go get github.com/gorilla/websocket

# Kompilujemy nasz program do pliku binarnego o nazwie 'server'
RUN go build -o server .

# Mówimy kontenerowi, co ma uruchomić po starcie
CMD ["./server"]