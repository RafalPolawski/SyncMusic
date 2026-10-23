# SyncMusic po polsku

SyncMusic to własny serwer muzyki do wspólnego słuchania: każdy otwiera aplikację na swoim telefonie, dołącza do pokoju i słyszy ten sam utwór w tym samym momencie, we własnych słuchawkach. Sprawdza się na siłowni, na wspólnym bieganiu i w trasie, czyli tam, gdzie internet bywa słaby.

## Jak to postawić

Potrzebujesz Dockera, katalogu z muzyką i adresu HTTPS dla telefonów. Najprościej dostać go przez [Tailscale](https://tailscale.com): działa między różnymi sieciami, bez przekierowywania portów, a certyfikat jest prawdziwy.

```sh
mkdir syncmusic && cd syncmusic
curl -fsSLO https://raw.githubusercontent.com/RafalPolawski/SyncMusic/main/compose.yaml
cat > .env <<'EOF'
MUSIC_DIR=/sciezka/do/muzyki
SYNCMUSIC_PASSWORD=wymysl-haslo
SYNCMUSIC_TRUST_PROXY=true
EOF
docker compose up -d
tailscale serve --bg 8080
```

Aplikacja będzie pod adresem `https://<nazwa-komputera>.<tailnet>.ts.net`. Znajomych zaproś do swojego tailnetu albo [udostępnij im ten komputer](https://tailscale.com/kb/1084/sharing). Muszą mieć zainstalowaną aplikację Tailscale na telefonie.

Na każdym telefonie otwórz adres, wpisz imię, pokój (np. „Siłownia”) i hasło, a potem wybierz w menu przeglądarki **Dodaj do ekranu głównego**. Od tej pory SyncMusic działa jak zwykła aplikacja.

Zamiast `tailscale serve` na komputerze możesz użyć gotowego kontenera z Tailscale: [`compose.tailscale.yaml`](../compose.tailscale.yaml) (opis w [deployment.md](deployment.md#option-b-tailscale-sidecar-container)).

## Jak ułożyć muzykę

```
muzyka/
├── Siłownia/            → playlista „Siłownia”
│   ├── 01 - Rozgrzewka.mp3
│   └── Nogi/            → podfolder, też należy do „Siłownia”
├── Chill/               → playlista „Chill”
├── bieganie.m3u         → playlista z pliku .m3u
└── Jakiś utwór.flac     → „Luźne utwory”
```

Tytuły i wykonawcy są brane z tagów, a jeśli ich nie ma, z nazwy pliku (np. `03 - Wykonawca - Tytuł.mp3`). Okładki są brane z pliku albo z `cover.jpg` / `folder.jpg` w katalogu. Nowe pliki są wykrywane same co 15 minut, a od razu po kliknięciu *Ustawienia → Przeskanuj bibliotekę*.

## Jak tego używać

- **Odtwórz / Losowo** na folderze włącza go całemu pokojowi. Menu **⋯** przy utworze pozwala dodać go do wspólnej kolejki albo zagrać jako następny.
- **Pauza w aplikacji** zatrzymuje cały pokój. **Przyciski słuchawek, ekran blokady i połączenia telefoniczne** pauzują tylko twój telefon, więc wyjęcie słuchawek między seriami nie zatrzymuje wszystkich. Można to zmienić w ustawieniach. *Wróć do pokoju* znowu włącza muzykę, równo z innymi.
- **Pobierz offline** na folderze zapisuje go w telefonie. Dodatkowo kilka następnych utworów zawsze pobiera się w tle.
- **Bez internetu muzyka gra dalej**, a nawet przechodzi do następnych utworów dokładnie wtedy, kiedy u innych. Po powrocie zasięgu telefon sam się synchronizuje.
- **Słuchawki Bluetooth** mają opóźnienie. Jeśli słyszysz muzykę później niż koledzy, przesuń *Ustawienia → Opóźnienie słuchawek*.
- **Słaby internet?** Ustaw *Jakość → Niska* (ok. 0,5 MB na minutę) i pobierz playlisty przed wyjściem z domu.
- **Czekaj na wszystkich** (domyślnie włączone): po zmianie utworu pokój czeka, aż każdy go wczyta (maksymalnie kilka sekund), i wtedy startuje wszystkim naraz.

## Aktualizacja

```sh
docker compose pull && docker compose up -d
```

Telefony pokażą informację o nowej wersji. Po dotknięciu *Odśwież* aplikacja się zaktualizuje.

## Problemy

| Objaw | Co zrobić |
|---|---|
| Na ekranie widać „Dotknij, aby słuchać” | Przeglądarka blokuje dźwięk do pierwszego dotknięcia. Wystarczy dotknąć ekranu. |
| Ktoś gra później niż reszta | Najczęściej to opóźnienie słuchawek Bluetooth, ustaw je w ustawieniach. Różnicę każdej osoby widać w *Teraz gra → Słuchacze*. |
| Brak instalacji jako aplikacja lub brak trybu offline | Strona musi być otwarta przez HTTPS (Tailscale Serve albo reverse proxy). |
| „Aplikacja jest otwarta w innej karcie” | Zamknij drugą kartę albo dotknij *Używaj tutaj*. |

Więcej technicznych szczegółów jest w [README](../README.md) i [architecture.md](architecture.md) (po angielsku).
