// Prowadzi kolejkę remanentów i przyjęć towaru z aplikacji Remanent w arkuszu, z której co minutę pobiera je
// kontener art-repricer (raport mailem wysyła kontener). Starsza wersja aplikacji wysyła jeszcze pliki CSV/XLSX — te idą mailem stąd.
// Instrukcja w README.md obok.

// Klucze NIE są w kodzie — Ustawienia projektu → Właściwości skryptu:
//   KLUCZ_TELEFON  — ten sam co w aplikacji (⚙ → Klucz wysyłki)
//   KLUCZ_KONTENER — ten sam co REMANENT_GAS_KEY w .env kontenera
const P = PropertiesService.getScriptProperties();

const ALARM_DO = 'jacek@lim-czestochowa.com.pl';
const ALARM_PO_MIN = 30;

const TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
// rewizja: licznik podmian z telefonu — kontener odsyła ją w „zakoncz”, żeby nie zamknąć nowszej wersji starymi danymi
// tryb: pelny | czesciowy (remanent) albo przyjecie; dokument tylko przy przyjęciu
const KOLUMNY = ['id', 'zakonczono', 'tryb', 'pozycje', 'to', 'status', 'przyjeto', 'zmieniono', 'podsumowanie', 'blad', 'alarm', 'rewizja', 'dokument'];
const K = Object.fromEntries(KOLUMNY.map((k, i) => [k, i]));
const STATUSY_KONCOWE = ['test', 'zapisany', 'blad', 'recznie'];
const TRYBY_REMANENTU = ['pelny', 'czesciowy'];
// Lista produktów dla telefonu (EAN → nazwa + podpowiedź, co zrobi kontener); zakładka „katalog” w arkuszu kolejki
const AKCJE_TELEFONU = ['katalog_info', 'katalog_pobierz'];
const KATALOG_KOLUMNY = ['ean', 'status', 'sku', 'nazwa', 'powod'];
const STATUSY_KATALOGU = ['lim', 'nowy', 'recznie'];

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (AKCJE_TELEFONU.includes(d.akcja)) return telefonKatalog(d);
    return d.akcja ? kontener(d) : telefon(d);
  } catch (err) {
    return out(false, String(err.message || err));
  }
}

// Wejście na adres skryptu w przeglądarce — szybki test, że wdrożenie działa
function doGet() {
  return out(false, 'Dozwolony tylko POST');
}

/* ---------- Aplikacja na telefonie ---------- */
// Aplikacja wysyła same dane remanentu do kolejki; raport mailem wysyła kontener.
// Pliki mailem tylko dla starszej wersji aplikacji, która wysyła je razem z adresem.
function telefon(d) {
  if (!kluczOk(d.key, 'KLUCZ_TELEFON')) return out(false, 'Zły klucz wysyłki');
  if (d.przyjecie) return zapiszPrzyjecie(d.przyjecie);
  const maPliki = (d.files || []).length > 0;
  if (!d.remanent && !maPliki) return out(false, 'Brak danych remanentu');
  const to = String(d.to || '').trim();
  if (maPliki && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return out(false, 'Błędny adres e-mail');
  // Najpierw kolejka, potem mail: gdy mail się nie uda, telefon ponowi z tym samym id i nic się nie zdubluje
  if (d.remanent) zapiszRemanent(d.remanent, to);
  if (maPliki) wyslijPliki(d, to);
  return out(true);
}

function wyslijPliki(d, to) {
  const files = d.files.slice(0, 4).map(f => {
    const name = String(f.name).replace(/[^A-Za-z0-9_.-]/g, '_');
    const ext = name.split('.').pop().toLowerCase();
    if (!TYPES[ext]) throw new Error('Niedozwolony typ pliku');
    return Utilities.newBlob(Utilities.base64Decode(f.data), TYPES[ext], name);
  });
  MailApp.sendEmail({
    to: to,
    subject: String(d.subject || 'Remanent').slice(0, 150),
    body: String(d.body || '').slice(0, 4000),
    name: 'Remanent',
    attachments: files
  });
}

function zapiszRemanent(r, to) {
  if (r.wersja !== 1) throw new Error('Nieobsługiwana wersja danych remanentu');
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('Błędny identyfikator remanentu');
  if (!TRYBY_REMANENTU.includes(r.tryb)) throw new Error('Błędny tryb remanentu');
  const poz = pozycje(r.pozycje, 0);
  if (!poz.length) throw new Error('Remanent bez pozycji');
  const wiersz = [id, String(r.zakonczono || ''), r.tryb, poz.join(';'), to, 'nowy', teraz(), teraz(), '', '', '', '1', ''];

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = arkusz();
    const n = znajdz(sh, id);
    if (!n) { zapiszWiersz(sh, 0, wiersz); return; }
    // Ponowienie tego samego remanentu: podmieniamy dane, dopóki kontener go nie przetworzył
    const stary = sh.getRange(n, 1, 1, KOLUMNY.length).getValues()[0];
    if (stary[K.status] !== 'nowy') throw new Error('Ten remanent został już przetworzony (' + stary[K.status] + ') — zresetuj listę');
    wiersz[K.rewizja] = String((Number(stary[K.rewizja]) || 1) + 1);
    zapiszWiersz(sh, n, wiersz);
  } finally {
    lock.releaseLock();
  }
}

// Pozycje jako „ean:ilosc” rozdzielone średnikiem; min — najmniejsza dozwolona ilość
function pozycje(lista, min) {
  return (lista || []).map(p => {
    const ean = String(p.ean || '');
    const ilosc = Number(p.ilosc);
    if (!/^\d{8,14}$/.test(ean) || !Number.isInteger(ilosc) || ilosc < min) throw new Error('Błędna pozycja: ' + ean);
    return ean + ':' + ilosc;
  });
}

/* ---------- Przyjęcie towaru: kontener dodaje ilości do stanu LIM- albo zakłada LIM-0- ---------- */
// Dodawanie nie jest idempotentne, więc po pobraniu przez kontener (status w_toku) telefon nie może już podmienić pozycji
// Numer przyjęcia nadaje skrypt: kolejny w miesiącu (numer/MM/RRRR), więc nie ma literówek ani duplikatów
function zapiszPrzyjecie(r) {
  if (r.wersja !== 1) return out(false, 'Nieobsługiwana wersja danych przyjęcia');
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return out(false, 'Błędny identyfikator przyjęcia');
  const poz = pozycje(r.pozycje, 1);
  if (!poz.length) return out(false, 'Przyjęcie bez pozycji');
  const wiersz = [id, String(r.zakonczono || ''), 'przyjecie', poz.join(';'), '', 'nowy', teraz(), teraz(), '', '', '', '1', ''];

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = arkusz();
    const w = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, KOLUMNY.length).getValues();
    const n = w.findIndex(x => String(x[K.id]) === id);
    const stary = n < 0 ? null : w[n];
    if (stary) {
      // Ponowienie z telefonu: numer zostaje ten sam
      wiersz[K.dokument] = String(stary[K.dokument]);
      // Po zgubionej odpowiedzi te same dane już są w kolejce — sukces bez zmian
      if (stary[K.pozycje] === wiersz[K.pozycje]) return out(true, '', odpowiedzPrzyjecia(wiersz[K.dokument]));
      if (stary[K.status] !== 'nowy') {
        return out(false, 'To przyjęcie jest już przetwarzane (' + stary[K.status] + ') — zmiany wyślij jako nowe przyjęcie');
      }
      wiersz[K.rewizja] = String((Number(stary[K.rewizja]) || 1) + 1);
      zapiszWiersz(sh, n + 2, wiersz);
    } else {
      wiersz[K.dokument] = nastepnyNumer(w);
      zapiszWiersz(sh, 0, wiersz);
    }
  } finally {
    lock.releaseLock();
  }
  return out(true, '', odpowiedzPrzyjecia(wiersz[K.dokument]));
}

// Kolejny numer w bieżącym miesiącu (czas polski). Licznik we właściwościach skryptu chroni przed
// ponownym nadaniem numeru, gdyby ktoś usunął wiersze z arkusza; wołać pod blokadą.
function nastepnyNumer(w) {
  const mr = Utilities.formatDate(new Date(), 'Europe/Warsaw', 'MM/yyyy');
  const klucz = 'PRZYJECIE_NR_' + mr;
  let max = Number(P.getProperty(klucz)) || 0;
  w.forEach(x => {
    const m = String(x[K.dokument]).match(/^(\d+)\/(\d\d\/\d{4})$/);
    if (x[K.tryb] === 'przyjecie' && m && m[2] === mr) max = Math.max(max, Number(m[1]));
  });
  P.setProperty(klucz, String(max + 1));
  return (max + 1) + '/' + mr;
}

// Telefon pokazuje nadany numer i to, czy kontener faktycznie zmieni stany (tryb zgłasza kontener przy pobieraniu)
function odpowiedzPrzyjecia(dokument) {
  return {dokument: dokument, kontener_tryb: P.getProperty('PRZYJECIE_TRYB_KONTENERA') || ''};
}

// Zwraca nowe i rozpoczęte (restart kontenera między pobraniem a „zakoncz”); nowe oznacza jako w_toku
function przyjeciaDoPobrania(d) {
  if (d.tryb) P.setProperty('PRZYJECIE_TRYB_KONTENERA', String(d.tryb).slice(0, 20));
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = arkusz();
    if (sh.getLastRow() < 2) return [];
    const w = sh.getRange(2, 1, sh.getLastRow() - 1, KOLUMNY.length).getValues();
    const wynik = [];
    w.forEach((x, i) => {
      if (x[K.tryb] !== 'przyjecie' || !['nowy', 'w_toku'].includes(x[K.status])) return;
      if (x[K.status] === 'nowy') {
        x[K.status] = 'w_toku';
        sh.getRange(i + 2, K.status + 1).setValue('w_toku');
        sh.getRange(i + 2, K.zmieniono + 1).setValue(teraz());
      }
      wynik.push(x);
    });
    return wynik
      .sort((a, b) => String(a[K.przyjeto]).localeCompare(String(b[K.przyjeto])))
      .map(x => Object.assign(wpis(x), {dokument: String(x[K.dokument]), status: x[K.status]}));
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Kontener art-repricer ---------- */
function kontener(d) {
  if (!kluczOk(d.key, 'KLUCZ_KONTENER')) return out(false, 'Zły klucz kontenera');
  if (d.akcja === 'pobierz') return out(true, '', {remanenty: nowe()});
  if (d.akcja === 'pobierz_przyjecia') return out(true, '', {przyjecia: przyjeciaDoPobrania(d)});
  if (d.akcja === 'zakoncz') return zakoncz(d);
  if (d.akcja === 'katalog_zapisz') return katalogZapisz(d);
  return out(false, 'Nieznana akcja');
}

/* ---------- Lista produktów: kontener zapisuje, telefon pobiera ---------- */
function katalogZapisz(d) {
  if (d.wersja !== 1) return out(false, 'Nieobsługiwana wersja katalogu');
  const poz = d.pozycje;
  if (!Array.isArray(poz) || !poz.length) return out(false, 'Katalog bez pozycji');
  const wiersze = poz.map(p => {
    if (!Array.isArray(p) || !/^\d{13}$/.test(String(p[0])) || !STATUSY_KATALOGU.includes(p[1])) {
      throw new Error('Błędna pozycja katalogu: ' + JSON.stringify(p).slice(0, 80));
    }
    return [String(p[0]), p[1], String(p[2] || ''), String(p[3] || '').slice(0, 120), String(p[4] || '')];
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = katalogArkusz(wiersze.length + 1);
    sh.getRange(1, 1, wiersze.length + 1, KATALOG_KOLUMNY.length).setValues([KATALOG_KOLUMNY].concat(wiersze));
    P.setProperties({
      KATALOG_WYGENEROWANO: String(d.wygenerowano || ''),
      KATALOG_FEED_Z: String(d.feed_z || ''),
      KATALOG_LICZBY: JSON.stringify(d.liczby || {}),
      KATALOG_N: String(wiersze.length),
      KATALOG_ZAPISANO: teraz()
    });
  } finally {
    lock.releaseLock();
  }
  return out(true, '', {liczba: wiersze.length});
}

// Zakładka „katalog” przycięta dokładnie do liczby wierszy: mniej komórek = szybszy zapis i odczyt
function katalogArkusz(n) {
  const ss = arkusz().getParent();
  const sh = ss.getSheetByName('katalog') || ss.insertSheet('katalog');
  sh.clearContents();
  const kol = KATALOG_KOLUMNY.length;
  if (sh.getMaxColumns() > kol) sh.deleteColumns(kol + 1, sh.getMaxColumns() - kol);
  if (sh.getMaxRows() < n) sh.insertRowsAfter(sh.getMaxRows(), n - sh.getMaxRows());
  else if (sh.getMaxRows() > n) sh.deleteRows(n + 1, sh.getMaxRows() - n);
  sh.getRange(1, 1, n, kol).setNumberFormat('@');   // EAN-y jako tekst
  return sh;
}

function katalogInfo() {
  return {
    wygenerowano: P.getProperty('KATALOG_WYGENEROWANO') || '',
    feed_z: P.getProperty('KATALOG_FEED_Z') || '',
    liczby: JSON.parse(P.getProperty('KATALOG_LICZBY') || '{}'),
    liczba: Number(P.getProperty('KATALOG_N') || 0)
  };
}

function telefonKatalog(d) {
  if (!kluczOk(d.key, 'KLUCZ_TELEFON')) return out(false, 'Zły klucz wysyłki');
  const info = katalogInfo();
  if (d.akcja === 'katalog_info' || !info.liczba) return out(true, '', info);
  const sh = arkusz().getParent().getSheetByName('katalog');
  const pozycje = sh ? sh.getRange(2, 1, info.liczba, KATALOG_KOLUMNY.length).getValues() : [];
  return out(true, '', Object.assign(info, {pozycje: pozycje}));
}

// Same remanenty — przyjęcia idą osobną akcją, żeby kontener nie wziął ich za remanent częściowy
function nowe() {
  const sh = arkusz();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, KOLUMNY.length).getValues()
    .filter(w => w[K.status] === 'nowy' && TRYBY_REMANENTU.includes(w[K.tryb]))
    .sort((a, b) => String(a[K.przyjeto]).localeCompare(String(b[K.przyjeto])))
    .map(wpis);
}

function wpis(w) {
  return {
    wersja: 1,
    id: String(w[K.id]),
    tryb: w[K.tryb],
    zakonczono: String(w[K.zakonczono]),
    przyjeto: String(w[K.przyjeto]),   // zegar GAS — kontener porównuje z zegarem telefonu
    rewizja: Number(w[K.rewizja]),
    to: w[K.to],
    pozycje: String(w[K.pozycje]).split(';').map(p => {
      const [ean, ilosc] = p.split(':');
      return {ean: ean, ilosc: Number(ilosc)};
    })
  };
}

function zakoncz(d) {
  if (!STATUSY_KONCOWE.includes(d.status)) return out(false, 'Błędny status');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = arkusz();
    const n = znajdz(sh, String(d.id || ''));
    if (!n) return out(false, 'Nie ma remanentu ani przyjęcia o tym id');
    // Telefon podmienił pozycje w trakcie przetwarzania — status zostaje „nowy”, kontener weźmie nową wersję
    if (String(sh.getRange(n, K.rewizja + 1).getValue()) !== String(d.rewizja)) return out(false, 'Zmieniona rewizja');
    sh.getRange(n, K.status + 1).setValue(d.status);
    sh.getRange(n, K.zmieniono + 1, 1, 3).setValues([[
      teraz(), d.podsumowanie ? JSON.stringify(d.podsumowanie) : '', String(d.blad || '')
    ]]);
    return out(true);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Alarm: kontener nie odebrał albo nie dokończył remanentu / przyjęcia ---------- */
// Wyzwalacz czasowy co 15 min, zakładany funkcją ustaw()
function alarm() {
  if (wOknie(new Date())) return;   // kontener celowo czeka do końca okna zamówień InnPro
  const sh = arkusz();
  if (sh.getLastRow() < 2) return;
  const w = sh.getRange(2, 1, sh.getLastRow() - 1, KOLUMNY.length).getValues();
  const limit = Date.now() - ALARM_PO_MIN * 60000;
  w.forEach((r, i) => {
    if (!['nowy', 'w_toku'].includes(r[K.status]) || r[K.alarm] || new Date(r[K.przyjeto]).getTime() > limit) return;
    const co = r[K.tryb] === 'przyjecie' ? `Przyjęcie ${r[K.dokument]}` : 'Remanent';
    MailApp.sendEmail(ALARM_DO, `${co}: kontener nie przetworzył w ${ALARM_PO_MIN} min`,
      `${co} (id ${r[K.id]}, przyjęty ${r[K.przyjeto]}, status ${r[K.status]}) czeka w kolejce dłużej niż ${ALARM_PO_MIN} min.\n` +
      `Sprawdź, czy kontener art-repricer działa. Arkusz kolejki: ${sh.getParent().getUrl()}`);
    sh.getRange(i + 2, K.alarm + 1).setValue(teraz());
  });
}

// Dni robocze 13:45–14:45: okno zamówień InnPro (13:45–14:30) plus kwadrans na odebranie po nim
function wOknie(d) {
  const dz = d.getDay(), m = d.getHours() * 60 + d.getMinutes();
  return dz >= 1 && dz <= 5 && m >= 13 * 60 + 45 && m < 14 * 60 + 45;
}

/* ---------- Jednorazowa konfiguracja: uruchom ręcznie w edytorze ---------- */
function ustaw() {
  const brak = ['KLUCZ_TELEFON', 'KLUCZ_KONTENER'].filter(k => !P.getProperty(k));
  if (brak.length) throw new Error('Brak właściwości skryptu: ' + brak.join(', '));
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'alarm')) {
    ScriptApp.newTrigger('alarm').timeBased().everyMinutes(15).create();
  }
  Logger.log('Arkusz kolejki: ' + arkusz().getParent().getUrl());
}

/* ---------- Pomocnicze ---------- */
function arkusz() {
  let id = P.getProperty('ARKUSZ_ID');
  if (id) {
    const sh = SpreadsheetApp.openById(id).getSheets()[0];
    // Arkusz sprzed dodania kolumny „dokument”: dopisz nagłówek
    if (sh.getLastColumn() < KOLUMNY.length) {
      sh.getRange(1, 1, sh.getMaxRows(), KOLUMNY.length).setNumberFormat('@');
      sh.getRange(1, 1, 1, KOLUMNY.length).setValues([KOLUMNY]);
    }
    return sh;
  }
  const ss = SpreadsheetApp.create('Remanent — kolejka');
  const sh = ss.getSheets()[0];
  sh.setName('kolejka');
  sh.getRange(1, 1, sh.getMaxRows(), KOLUMNY.length).setNumberFormat('@');   // wszystko tekstem: EAN-y i daty bez autokonwersji
  sh.appendRow(KOLUMNY);
  sh.setFrozenRows(1);
  P.setProperty('ARKUSZ_ID', ss.getId());
  return sh;
}

// Zapis wiersza kolejki jako czysty tekst (n = 0: nowy wiersz na końcu). appendRow i setValues bez
// formatu tekstowego zamieniają „1/10/2026” na datę, a „ean:ilość” mogą wziąć za czas.
function zapiszWiersz(sh, n, wiersz) {
  if (!n) {
    n = sh.getLastRow() + 1;
    if (n > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  }
  sh.getRange(n, 1, 1, wiersz.length).setNumberFormat('@').setValues([wiersz]);
}

function znajdz(sh, id) {
  if (sh.getLastRow() < 2) return 0;
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  const i = ids.findIndex(r => String(r[0]) === id);
  return i < 0 ? 0 : i + 2;
}

function kluczOk(podany, nazwa) {
  const k = P.getProperty(nazwa);
  return !!k && podany === k;
}

function teraz() {
  return Utilities.formatDate(new Date(), 'Europe/Warsaw', "yyyy-MM-dd'T'HH:mm:ssXXX");   // ISO ze strefą
}

function out(ok, error, dane) {
  return ContentService
    .createTextOutput(JSON.stringify(Object.assign(ok ? {ok: true} : {ok: false, error: error}, dane)))
    .setMimeType(ContentService.MimeType.JSON);
}
