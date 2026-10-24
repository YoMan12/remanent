<?php
// Skopiuj jako mail-config.php (nie trafia do repo) i uzupełnij.

// Ten sam klucz wpisujesz w aplikacji: Ustawienia → Wysyłka maila → Klucz wysyłki
define('MAIL_KEY', 'wpisz-tu-dlugi-losowy-ciag');

// Nadawca — adres w domenie hostingu, inaczej maile lądują w spamie albo są odrzucane
define('MAIL_FROM', 'remanent@lim-czestochowa.com.pl');
define('MAIL_FROM_NAME', 'Remanent');

// Skąd aplikacja może wysyłać (sam host, bez /remanent/); '*' = z dowolnej strony (chroni wtedy tylko klucz)
define('ALLOWED_ORIGIN', 'https://yoman12.github.io');
