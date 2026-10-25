# Skrypt Google: wysyłka maila i kolejka remanentów

Tymczasowe zastępstwo dla `serwer/mail.php`, dopóki nie ma dostępu do hostingu.

- **Telefon → skrypt:** pliki CSV/XLSX idą mailem (z konta Google właściciela skryptu,
  limit ok. 100 odbiorców dziennie), a dane remanentu trafiają do kolejki w arkuszu
  „Remanent — kolejka” (tworzy go skrypt).
- **Kontener art-repricer → skrypt:** co minutę `{"akcja":"pobierz"}` zwraca remanenty
  ze statusem `nowy`, a `{"akcja":"zakoncz"}` ustawia status `test | zapisany | blad | recznie`.
- **Alarm:** co 15 min. Jeśli remanent czeka dłużej niż 30 min, idzie mail
  (poza oknem zamówień InnPro w dni robocze 13:45–14:45).

## Klucze: Ustawienia projektu → Właściwości skryptu

| właściwość | gdzie ta sama wartość |
|---|---|
| `KLUCZ_TELEFON` | aplikacja: ⚙ → Klucz wysyłki |
| `KLUCZ_KONTENER` | `.env` kontenera: `REMANENT_GAS_KEY` |

`ARKUSZ_ID` skrypt ustawia sam. Klucze nie są w kodzie, bo repo jest publiczne.

## Kod: clasp (z tego folderu)

    clasp push                                  # kod na konto (wersja robocza, wdrożeń nie rusza)
    clasp version "opis"                        # nowa wersja
    clasp deploy -i <ID wdrożenia> -V <wersja>  # podmiana wersji pod istniejącym adresem /exec

Po pierwszym wgraniu albo po dojściu nowych uprawnień uruchom raz w edytorze funkcję
`ustaw` i zatwierdź dostęp. Sprawdza klucze, zakłada wyzwalacz alarmu i arkusz.

Test: otwarcie adresu `/exec` w przeglądarce ma pokazać `{"ok":false,"error":"Dozwolony tylko POST"}`.
