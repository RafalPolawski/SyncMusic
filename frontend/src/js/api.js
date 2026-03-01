// Moduł odpowiedzialny za zapytania do backendu
export const fetchSongsLibrary = async () => {
    try {
        const response = await fetch('/api/songs');
        if (!response.ok) throw new Error("Błąd pobierania piosenek");
        return await response.json();
    } catch (e) {
        console.error(e);
        return null;
    }
};
