<?php
// Odbiera z aplikacji pliki remanentu (CSV, XLSX) i wysyła je mailem jako załączniki.
// Wymaga obok pliku mail-config.php (wzór: mail-config.example.php).
require __DIR__ . '/mail-config.php';

header('Access-Control-Allow-Origin: ' . ALLOWED_ORIGIN);
header('Content-Type: application/json; charset=utf-8');

function done($ok, $err = '', $code = 400) {
    if (!$ok) http_response_code($code);
    echo json_encode($ok ? ['ok' => true] : ['ok' => false, 'error' => $err], JSON_UNESCAPED_UNICODE);
    exit;
}
// Nagłówki maila z tekstem spoza ASCII
function enc($s) { return '=?UTF-8?B?' . base64_encode($s) . '?='; }

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;
if ($_SERVER['REQUEST_METHOD'] !== 'POST') done(false, 'Dozwolony tylko POST', 405);
if (!hash_equals(MAIL_KEY, (string)($_POST['key'] ?? ''))) done(false, 'Zły klucz wysyłki', 403);

$to = trim((string)($_POST['to'] ?? ''));
if (!filter_var($to, FILTER_VALIDATE_EMAIL)) done(false, 'Błędny adres e-mail');

$subject = str_replace(["\r", "\n"], ' ', mb_substr((string)($_POST['subject'] ?? 'Remanent'), 0, 150));
$body = mb_substr((string)($_POST['body'] ?? ''), 0, 4000);

$f = $_FILES['files'] ?? null;
if (!$f || !is_array($f['name']) || count($f['name']) < 1 || count($f['name']) > 4) done(false, 'Brak plików');

$types = ['csv' => 'text/csv; charset=utf-8', 'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
$boundary = 'b_' . bin2hex(random_bytes(12));
$msg = "--$boundary\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
     . chunk_split(base64_encode($body));

foreach ($f['name'] as $i => $name) {
    if ($f['error'][$i] !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'][$i])) done(false, 'Błąd przesyłania pliku');
    if ($f['size'][$i] > 5 * 1024 * 1024) done(false, 'Plik za duży');
    $name = preg_replace('/[^A-Za-z0-9_.-]/', '_', basename($name));
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    if (!isset($types[$ext])) done(false, 'Niedozwolony typ pliku');
    $msg .= "--$boundary\r\nContent-Type: {$types[$ext]}; name=\"$name\"\r\nContent-Transfer-Encoding: base64\r\n"
          . "Content-Disposition: attachment; filename=\"$name\"\r\n\r\n"
          . chunk_split(base64_encode(file_get_contents($f['tmp_name'][$i])));
}
$msg .= "--$boundary--\r\n";

$headers = 'From: ' . enc(MAIL_FROM_NAME) . ' <' . MAIL_FROM . ">\r\n"
         . "MIME-Version: 1.0\r\n"
         . "Content-Type: multipart/mixed; boundary=\"$boundary\"";

if (!mail($to, enc($subject), $msg, $headers, '-f' . MAIL_FROM)) done(false, 'Serwer nie wysłał maila', 500);
done(true);
