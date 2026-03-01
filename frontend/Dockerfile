FROM node:24-alpine
WORKDIR /app

# Kopiowanie plików definicji pakietów
COPY package.json package-lock.json* ./

# Instalujemy zależności używając wewnętrznego menedżera npm z alpine (Nie wymaga gita z Windowsa klienta)
RUN npm install

# Kopiowanie reszty źródła frontendu
COPY . .

EXPOSE 5173

# Komenda odpalająca serwer dev z obsługa hmr
CMD ["npm", "run", "dev", "--", "--host"]
