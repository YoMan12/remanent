# Wysyłka maila przez Google Apps Script

Tymczasowe zastępstwo dla `serwer/mail.php`, dopóki nie ma dostępu do hostingu.
Maile wychodzą z konta Google, na którym wdrożysz skrypt (limit ok. 100 odbiorców dziennie).

1. Wejdź na https://script.google.com → **Nowy projekt**.
2. Usuń przykładowy kod i wklej całą zawartość `Code.gs`.
3. W linii `const KEY = '...'` wpisz własny długi losowy ciąg i zapisz (Ctrl+S).
4. **Wdróż → Nowe wdrożenie** → typ (ikona zębatki): **Aplikacja internetowa**.
   - Wykonaj jako: **Ja**
   - Kto ma dostęp: **Każdy**
5. **Wdróż** → zezwól na dostęp (Google ostrzeże o niezweryfikowanej aplikacji:
   *Zaawansowane → Przejdź do projektu*). To Twój własny skrypt.
6. Skopiuj **URL aplikacji internetowej** (kończy się na `/exec`).
7. W aplikacji Remanent → Ustawienia → Wysyłka maila:
   - Adres skryptu: skopiowany URL
   - Klucz wysyłki: ten sam ciąg co w `KEY`

Test: otwarcie URL w przeglądarce ma pokazać `{"ok":false,"error":"Dozwolony tylko POST"}`.

Po zmianie kodu skryptu: **Wdróż → Zarządzaj wdrożeniami → edytuj (ołówek) → Wersja: Nowa**
— wtedy URL zostaje ten sam.
