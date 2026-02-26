package main

import (
	"log"
	"net/http"
	"sync"
	"github.com/gorilla/websocket"
)

// Konfiguracja WebSocketów (pozwala na łączenie się z dowolnego źródła)
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Przechowujemy listę wszystkich podłączonych użytkowników
var clients = make(map[*websocket.Conn]bool)
var mutex sync.Mutex // Zabezpiecza przed błędami, gdy wielu uzytkowników wbija naraz

// Funkcja obsługująca połączenie z nowym telefonem/przeglądarką
func handleConnections(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}
	defer ws.Close()

	// Dodajemy nowego klienta do listy
	mutex.Lock()
	clients[ws] = true
	mutex.Unlock()

	log.Println("Nowy użytkownik podłączony!")

	// Pętla nasłuchująca wiadomości od tego klienta
	for {
		var msg map[string]interface{}
		// Czekamy na wiadomość (np. kliknięcie Play)
		err := ws.ReadJSON(&msg)
		if err != nil {
			log.Println("Użytkownik się rozłączył")
			mutex.Lock()
			delete(clients, ws)
			mutex.Unlock()
			break
		}

		// Ktoś coś kliknął! Rozsyłamy tę wiadomość do WSZYSTKICH w pokoju
		mutex.Lock()
		for client := range clients {
			err := client.WriteJSON(msg)
			if err != nil {
				client.Close()
				delete(clients, client)
			}
		}
		mutex.Unlock()
	}
}

func main() {
	// 1. Serwujemy pliki naszej strony internetowej (frontend)
	http.Handle("/", http.FileServer(http.Dir("./frontend")))
	
	// 2. Otwieramy kanał komunikacji w czasie rzeczywistym (WebSocket)
	http.HandleFunc("/ws", handleConnections)

	log.Println("Serwer wystartował na porcie :12137! Rakieta gotowa.")
	err := http.ListenAndServe(":12137", nil)
	if err != nil {
		log.Fatal("Błąd serwera: ", err)
	}
}