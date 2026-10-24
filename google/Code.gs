// Odbiera z aplikacji Remanent pliki (CSV, XLSX) i wysyła je mailem z Twojego konta Google.
// Wklej do projektu na script.google.com i wdróż jako aplikację internetową (instrukcja w README.md obok).

// Ten sam klucz wpisujesz w aplikacji: Ustawienia → Wysyłka maila → Klucz wysyłki
const KEY = 'wpisz-tu-dlugi-losowy-ciag';

const TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.key !== KEY) return out(false, 'Zły klucz wysyłki');
    const to = String(d.to || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return out(false, 'Błędny adres e-mail');
    const files = (d.files || []).slice(0, 4).map(f => {
      const name = String(f.name).replace(/[^A-Za-z0-9_.-]/g, '_');
      const ext = name.split('.').pop().toLowerCase();
      if (!TYPES[ext]) throw new Error('Niedozwolony typ pliku');
      return Utilities.newBlob(Utilities.base64Decode(f.data), TYPES[ext], name);
    });
    if (!files.length) return out(false, 'Brak plików');
    MailApp.sendEmail({
      to: to,
      subject: String(d.subject || 'Remanent').slice(0, 150),
      body: String(d.body || '').slice(0, 4000),
      name: 'Remanent',
      attachments: files
    });
    return out(true);
  } catch (err) {
    return out(false, String(err.message || err));
  }
}

// Wejście na adres skryptu w przeglądarce — szybki test, że wdrożenie działa
function doGet() {
  return out(false, 'Dozwolony tylko POST');
}

function out(ok, error) {
  return ContentService
    .createTextOutput(JSON.stringify(ok ? {ok: true} : {ok: false, error: error}))
    .setMimeType(ContentService.MimeType.JSON);
}
