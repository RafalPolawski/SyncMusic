Skrót tego co chce zrobić, z AI no bo jak to tak inaczej :)

🏛️ Warstwa 1: Sieć i Reverse Proxy (The Edge)
Tu dzieje się pierwsza magia. Zamiast standardowego TCP, przechodzimy na UDP, żeby zwalczyć opóźnienia.

Protokół: HTTP/3 (QUIC). To absolutny wymóg. QUIC działa na UDP. Jego największa zaleta? Posiada "Connection Migration". Jeśli Twój telefon na siłowni straci na chwilę zasięg LTE i zmieni mu się adres IP, połączenie TCP zostałoby zerwane i musiałoby nawiązywać się od nowa (lag). QUIC tego nie robi – płynnie wznawia przesył danych.

Reverse Proxy: Caddy lub Traefik. Oba świetnie wspierają HTTP/3 out-of-the-box. Będą one stać na froncie (nawet wewnątrz sieci Tailscale), terminować ruch szyfrowany i kierować go do odpowiednich mikroserwisów.

🧠 Warstwa 2: Serwer Aplikacji (Control Plane)
Serwer nie odtwarza muzyki. Serwer jest wyłącznie "dyrygentem".

Język: Golang (Go) lub Rust. Wybierz Go, jeśli chcesz szybciej dowieźć projekt (świetny ekosystem sieciowy), lub Rust, jeśli chcesz absolutnie zerowego narzutu Garbage Collectora i maksymalnej prędkości z pamięcią. W obu napiszesz serwer, który udźwignie tysiące połączeń zużywając 50 MB RAM-u.

Komunikacja z klientem: WebTransport (zamiast WebSockets). WebTransport to nowszy standard oparty na HTTP/3. W przeciwieństwie do WebSockets (które działają na TCP), WebTransport pozwala na wysyłanie małych, niezawodnych wiadomości bez blokowania całego kanału, gdy jeden pakiet się zgubi.

Algorytm Synchronizacji (NTP-style): To klucz do wydajności. Serwer nie wysyła komendy "Graj teraz!". Telefony mają różne opóźnienia sieciowe (ping).

Aplikacja mobilna po połączeniu "pinguje" serwer kilka razy i oblicza swój offset czasu (różnicę między zegarem serwera a telefonu).

Kiedy klikasz "Play", serwer wysyła komendę: "Akcja: PLAY, Utwór: ID_123, Czas serwera wykonania: 1610000005.00".

Twój telefon i telefon kolegi czekają, aż ich lokalny czas (skorygowany o offset) zrówna się z zadanym czasem. Piosenka startuje u Was co do milisekundy, niezależnie od tego, czy Twój pakiet dotarł w 10 ms, a kolegi w 150 ms.

💾 Warstwa 3: Składowanie Danych (Storage Plane)
Rozdzielamy stan, pliki i dane użytkowników.

Baza Pamięci Podręcznej (State): Redis. To tutaj serwer Go trzyma aktualny stan "Pokoju", pozycję w utworze i kolejkę. Wszystko w pamięci RAM. Odczyt i zapis w mikrosekundach.

Baza Danych (Persystencja): PostgreSQL. Tylko do rzadkich operacji: logowanie użytkowników, zapisywanie gotowych playlist, metadane utworów.

Magazyn Plików Audio: MinIO (S3-compatible Object Storage). Nie trzymaj plików mp3/flac na dysku i nie serwuj ich przez serwer Go. Wgraj pliki do MinIO. Aplikacja kliencka pobiera pliki bezpośrednio z MinIO przez Reverse Proxy z użyciem zwykłego HTTP/2/3. MinIO jest w stanie wysyłać strumienie danych ekstremalnie szybko.

📱 Warstwa 4: Klient (Execution Plane)
Nawet najlepszy backend nie pomoże, jeśli frontend będzie głupi.

Technologia: Progressive Web App (PWA) napisana w Svelte lub SolidJS. Są to frameworki bez wirtualnego DOM-u (Virtual DOM), co oznacza błyskawiczne działanie na słabszych telefonach.

Agresywne Buforowanie (Service Workers & IndexedDB): Zanim utwór numer 1 się skończy, klient pobiera w tle utwór numer 2 i 3 prosto z MinIO i zapisuje je w lokalnej bazie przeglądarki (IndexedDB). Jeśli na siłowni padnie zasięg na minutę, Wy nadal macie muzykę, a gdy zasięg wróci, WebTransport przekaże tylko "nadrobiony" stan z serwera.

Odtwarzacz: Web Audio API. Daje pełną, niskopoziomową kontrolę nad buforami audio i pozwala na precyzyjne odtwarzanie dźwięku z dokładnością do pojedynczych klatek/próbek dźwiękowych, co jest wymagane przy naszym algorytmie NTP.
