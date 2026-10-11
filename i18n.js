const _I18N = {
  tr: {
    'app.title': 'Campus Dashboard',
    // login
    'login.username': 'Kullanıcı adı',
    'login.password': 'Şifre',
    'login.submit': 'Giriş Yap',
    'login.guest_btn': 'Misafir Olarak Gir',
    'login.or': 'veya',
    'login.create_acct': 'Hesap Oluştur',
    'login.guest_hint': 'Hangi kullanıcının panosunu görüntülemek istiyorsunuz?',
    'login.guest_none': 'Herkese açık pano yok',
    'login.guest_loading': 'Yükleniyor...',
    'login.guest_err': 'Kullanıcılar yüklenemedi',
    'login.guest_back': '← Geri',
    'login.reg_back': '← Giriş ekranına dön',
    'login.reg_user_hint': '(3-20 karakter, a-z 0-9 _)',
    'login.reg_pw_hint': '(en az 6 karakter)',
    'login.reg_pw2': 'Şifre tekrar',
    'login.reg_submit': 'Kayıt Ol',
    'login.err.generic': 'Giriş başarısız',
    'login.err.conn': 'Bağlantı hatası',
    'login.reg.mismatch': 'Şifreler eşleşmiyor',
    'login.reg.err': 'Kayıt başarısız',
    'login.reg.conn': 'Bağlantı hatası',
    'login.guest.err': 'Giriş başarısız',
    'login.guest.conn': 'Bağlantı hatası',
    // nav / header
    'nav.edit': 'Panoyu düzenle',
    'nav.account': 'Hesap',
    'nav.logout': 'Çıkış',
    'nav.lang': 'Switch to English',
    'nav.guest_label': 'Misafir',
    // account
    'acct.title': 'Hesap',
    'acct.back': '← Pano',
    'acct.profile': 'Profil',
    'acct.display_name': 'Görünen ad',
    'acct.display_name_hint': '(misafirlere kullanıcı adın yerine bu gösterilir)',
    'acct.save_name': 'Görünen Adı Kaydet',
    'acct.name_ok': 'Görünen ad güncellendi',
    'acct.name_fail': 'Görünen ad kaydedilemedi',
    'acct.change_pw': 'Şifre Değiştir',
    'acct.cur_pw': 'Mevcut şifre',
    'acct.new_pw': 'Yeni şifre',
    'acct.new_pw_hint': '(min 6 karakter)',
    'acct.confirm_pw': 'Yeni şifre tekrar',
    'acct.save_pw': 'Şifreyi Kaydet',
    'acct.saving': 'Kaydediliyor...',
    'acct.pw_ok': 'Şifre başarıyla değiştirildi',
    'acct.pw_mismatch': 'Şifreler eşleşmiyor',
    'acct.pw_wrong': 'Mevcut şifre yanlış',
    'acct.pw_fail': 'Şifre değiştirilemedi',
    'acct.logout': 'Çıkış Yap',
    'acct.share_title': 'Paylaşım Linki',
    'acct.share_hint': 'Bu linkle ziyaretçiler listelenmemiş bölümleri de görebilir.',
    'acct.copy': 'Kopyala',
    'acct.copied': 'Kopyalandı!',
    'acct.moodle_hint': 'Derslerini, yaklaşan teslim tarihlerini ve notlarını içe aktar. Bu butonu yer imleri çubuğuna sürükle, Moodle\'u (giriş yapmış olarak) aç ve yer imine tıkla:',
    'acct.moodle_drag': 'Bu butonu yer imleri çubuğuna sürükle, sonra Moodle sayfasındayken tıkla.',
    'acct.moodle_manual': 'Ya da bir Moodle web servis token\'ı yapıştır',
    'acct.moodle_connect': 'Bağlan',
    'acct.moodle_connecting': 'Bağlanıyor…',
    'acct.moodle_ok': 'Moodle bağlandı',
    'acct.moodle_fail': 'Moodle bağlanamadı',
    'acct.moodle_as': '{site} sitesine {name} olarak bağlı.',
    'acct.moodle_sync_hint': 'İçe aktarılacak dersleri düzenleyicideki “Moodle\'dan Eşitle” ile seç.',
    'acct.moodle_disconnect': 'Bağlantıyı Kes',
    'acct.moodle_wrong_site': 'Bu yer imi {site} üzerinde çalışır. Şimdi açılsın mı?',
    'acct.moodle_login': 'Önce Moodle\'a giriş yap, sonra yer imine tekrar tıkla.',
    // moodle sync (editor)
    'msync.button': '🔄 Moodle\'dan Eşitle',
    'msync.title': 'Moodle\'dan Eşitle',
    'msync.loading': 'Yükleniyor…',
    'msync.none': 'Moodle\'da kayıtlı ders bulunamadı.',
    'msync.hint': 'Seçilen dersler bu döneme eklenir ya da güncellenir. Yaklaşan ödev ve sınavlar Ödevler\'e eklenir; elle eklediklerin korunur.',
    'msync.grades': 'Notları da içe aktar',
    'msync.grades_hint': 'Notlar, ders bölümünü görebilen herkese görünür.',
    'msync.go': 'Eşitle',
    'msync.pick': 'En az bir ders seç',
    'msync.fail': 'Moodle\'a ulaşılamadı',
    'msync.connect': 'Hesap sayfasından Moodle\'a bağlan →',
    'msync.done': '{courses} ders eşitlendi ({added} yeni), {deadlines} teslim tarihi',
    // admin
    'adm.title': 'Panoyu Düzenle',
    'adm.save': 'Kaydet',
    'adm.saving': 'Kaydediliyor…',
    'adm.back': '← Pano',
    'adm.dash_title': 'Pano Başlığı',
    'adm.sections': 'Bölümler',
    'adm.add_section': '+ Bölüm Ekle',
    'adm.doc_lib': 'Belge Kütüphanesi',
    'adm.no_sections': 'Henüz bölüm yok. Aşağıdan ekle.',
    'adm.no_items': 'Henüz öğe yok.',
    'adm.add_item': '+ Öğe Ekle',
    'adm.del_section': 'Bölümü Sil',
    'adm.collapsed': 'Varsayılan kapalı',
    'adm.save_ok': 'Kaydedildi!',
    'adm.save_fail': 'Kayıt başarısız',
    'adm.load_fail': 'Veriler yüklenemedi',
    // visibility
    'vis.public': '🌐 Herkese Açık',
    'vis.unlisted': '🔗 Listelenmemiş',
    'vis.private': '🔒 Gizli',
    'vis.public.tip': 'Misafir listesinde görünür — değiştirmek için tıkla',
    'vis.unlisted.tip': 'Sadece link ile erişilebilir — değiştirmek için tıkla',
    'vis.private.tip': 'Misafirlerden gizli — değiştirmek için tıkla',
    // app dashboard strings
    'app.due_today': 'Bugün son gün',
    'app.due_tmrw': 'Yarın son gün',
    'app.due_in': 'Son: {n}g',
    'app.overdue': '{n}g gecikmiş',
    'app.today': 'Bugün!',
    'app.ago': '{n}g önce',
    'app.in_days': '{n}g sonra',
    'app.syllabus': 'Ders İzlencesi',
    'app.homework': '📚 Ödevler',
    'app.grades': '🎯 Notlar',
    'app.exams': '📝 Sınavlar',
    'app.slides': '🎞 Slaytlar',
    'app.resources': '📎 Kaynaklar',
    'app.empty': 'Bu dönemde henüz içerik yok.',
    'app.total_credits': 'Toplam {n} kredi',
    // semesters
    'sem.title': 'Dönemler',
    'sem.new': '+ Yeni Dönem',
    'sem.create': 'Oluştur',
    'sem.cancel': 'İptal',
    'sem.name_label': 'Dönem adı',
    'sem.archive_current': 'Mevcut dönemi arşivle',
    'sem.make_active': 'Aktif Yap',
    'sem.archive': 'Arşivle',
    'sem.unarchive': 'Arşivden Çıkar',
    'sem.rename': 'Yeniden Adlandır',
    'sem.rename_prompt': 'Yeni dönem adı:',
    'sem.delete': 'Sil',
    'sem.delete_confirm': '"{name}" dönemini silmek istediğinize emin misiniz? Bu dönemin tüm içeriği kalıcı olarak silinir.',
    'sem.active_badge': '● Aktif dönem',
    'sem.archived': '🗄 Arşivlenmiş',
    'sem.viewing': 'Görüntülenen dönem',
    'sem.created': 'Yeni dönem oluşturuldu',
    'sem.archived_ok': 'Dönem arşivlendi',
    'sem.unarchived_ok': 'Dönem arşivden çıkarıldı',
    'sem.activated': 'Dönem aktif yapıldı',
    'sem.renamed': 'Dönem yeniden adlandırıldı',
    'sem.deleted': 'Dönem silindi',
    'sem.err': 'İşlem başarısız',
  },
  en: {
    'app.title': 'Campus Dashboard',
    // login
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign In',
    'login.guest_btn': 'Continue as Guest',
    'login.or': 'or',
    'login.create_acct': 'Create Account',
    'login.guest_hint': 'Whose dashboard would you like to view?',
    'login.guest_none': 'No public dashboards available',
    'login.guest_loading': 'Loading...',
    'login.guest_err': 'Could not load users',
    'login.guest_back': '← Back',
    'login.reg_back': '← Back to login',
    'login.reg_user_hint': '(3-20 chars, a-z 0-9 _)',
    'login.reg_pw_hint': '(min 6 chars)',
    'login.reg_pw2': 'Confirm password',
    'login.reg_submit': 'Register',
    'login.err.generic': 'Login failed',
    'login.err.conn': 'Connection error',
    'login.reg.mismatch': 'Passwords do not match',
    'login.reg.err': 'Registration failed',
    'login.reg.conn': 'Connection error',
    'login.guest.err': 'Login failed',
    'login.guest.conn': 'Connection error',
    // nav / header
    'nav.edit': 'Edit dashboard',
    'nav.account': 'Account',
    'nav.logout': 'Logout',
    'nav.lang': 'Türkçeye geç',
    'nav.guest_label': 'Guest',
    // account
    'acct.title': 'Account',
    'acct.back': '← Dashboard',
    'acct.profile': 'Profile',
    'acct.display_name': 'Display name',
    'acct.display_name_hint': '(shown to guests instead of your username)',
    'acct.save_name': 'Save Display Name',
    'acct.name_ok': 'Display name updated',
    'acct.name_fail': 'Could not save display name',
    'acct.change_pw': 'Change Password',
    'acct.cur_pw': 'Current password',
    'acct.new_pw': 'New password',
    'acct.new_pw_hint': '(min 6 chars)',
    'acct.confirm_pw': 'Confirm new password',
    'acct.save_pw': 'Save Password',
    'acct.saving': 'Saving...',
    'acct.pw_ok': 'Password changed successfully',
    'acct.pw_mismatch': 'Passwords do not match',
    'acct.pw_wrong': 'Current password incorrect',
    'acct.pw_fail': 'Failed to change password',
    'acct.logout': 'Logout',
    'acct.share_title': 'Share Link',
    'acct.share_hint': 'Visitors with this link can also see your unlisted sections.',
    'acct.copy': 'Copy',
    'acct.copied': 'Copied!',
    'acct.moodle_hint': 'Import your courses, upcoming deadlines and grades. Drag this button to your bookmarks bar, open Moodle (logged in) and click the bookmark:',
    'acct.moodle_drag': 'Drag this button to your bookmarks bar, then click it while on the Moodle page.',
    'acct.moodle_manual': 'Or paste a Moodle web service token',
    'acct.moodle_connect': 'Connect',
    'acct.moodle_connecting': 'Connecting…',
    'acct.moodle_ok': 'Moodle connected',
    'acct.moodle_fail': 'Could not connect Moodle',
    'acct.moodle_as': 'Connected to {site} as {name}.',
    'acct.moodle_sync_hint': 'Pick courses to pull in with “Sync from Moodle” in the editor.',
    'acct.moodle_disconnect': 'Disconnect',
    'acct.moodle_wrong_site': 'This bookmark works on {site}. Open it now?',
    'acct.moodle_login': 'Log in to Moodle first, then click the bookmark again.',
    // moodle sync (editor)
    'msync.button': '🔄 Sync from Moodle',
    'msync.title': 'Sync from Moodle',
    'msync.loading': 'Loading…',
    'msync.none': 'No enrolled courses found on Moodle.',
    'msync.hint': 'Selected courses are added to or updated in this semester. Upcoming assignments and quizzes go to Homework; rows you added by hand are kept.',
    'msync.grades': 'Also import grades',
    'msync.grades_hint': 'Grades are visible to anyone who can see the courses section.',
    'msync.go': 'Sync',
    'msync.pick': 'Select at least one course',
    'msync.fail': 'Could not reach Moodle',
    'msync.connect': 'Connect Moodle on the Account page →',
    'msync.done': 'Synced {courses} courses ({added} new), {deadlines} deadlines',
    // admin
    'adm.title': 'Edit Dashboard',
    'adm.save': 'Save',
    'adm.saving': 'Saving…',
    'adm.back': '← Dashboard',
    'adm.dash_title': 'Dashboard Title',
    'adm.sections': 'Sections',
    'adm.add_section': '+ Add Section',
    'adm.doc_lib': 'Document Library',
    'adm.no_sections': 'No sections yet. Add one below.',
    'adm.no_items': 'No items yet.',
    'adm.add_item': '+ Add Item',
    'adm.del_section': 'Delete section',
    'adm.collapsed': 'Collapsed by default',
    'adm.save_ok': 'Saved!',
    'adm.save_fail': 'Save failed',
    'adm.load_fail': 'Failed to load data',
    // visibility
    'vis.public': '🌐 Public',
    'vis.unlisted': '🔗 Unlisted',
    'vis.private': '🔒 Private',
    'vis.public.tip': 'Visible in guest list — click to cycle',
    'vis.unlisted.tip': 'Link-only access — click to cycle',
    'vis.private.tip': 'Hidden from guests — click to cycle',
    // app dashboard strings
    'app.due_today': 'Due today',
    'app.due_tmrw': 'Due tomorrow',
    'app.due_in': 'Due in {n}d',
    'app.overdue': '{n}d overdue',
    'app.today': 'Today!',
    'app.ago': '{n}d ago',
    'app.in_days': 'in {n}d',
    'app.syllabus': 'Syllabus',
    'app.homework': '📚 Homework',
    'app.grades': '🎯 Grades',
    'app.exams': '📝 Exams',
    'app.slides': '🎞 Slides',
    'app.resources': '📎 Resources',
    'app.empty': 'No content in this semester yet.',
    'app.total_credits': '{n} total credits',
    // semesters
    'sem.title': 'Semesters',
    'sem.new': '+ New Semester',
    'sem.create': 'Create',
    'sem.cancel': 'Cancel',
    'sem.name_label': 'Semester name',
    'sem.archive_current': 'Archive the current semester',
    'sem.make_active': 'Make Active',
    'sem.archive': 'Archive',
    'sem.unarchive': 'Unarchive',
    'sem.rename': 'Rename',
    'sem.rename_prompt': 'New semester name:',
    'sem.delete': 'Delete',
    'sem.delete_confirm': 'Delete semester "{name}"? All of its content will be permanently removed.',
    'sem.active_badge': '● Active semester',
    'sem.archived': '🗄 Archived',
    'sem.viewing': 'Viewing semester',
    'sem.created': 'New semester created',
    'sem.archived_ok': 'Semester archived',
    'sem.unarchived_ok': 'Semester unarchived',
    'sem.activated': 'Semester set as active',
    'sem.renamed': 'Semester renamed',
    'sem.deleted': 'Semester deleted',
    'sem.err': 'Action failed',
  }
};

// Display labels for the lang-toggle button, shown for whichever language
// comes NEXT in the cycle. To add a language: add a block to _I18N above and
// a short code here — everything else (detection, toggle, button) adapts.
const _LANG_LABELS = {
  tr: 'TR',
  en: 'EN',
};

(function () {
  // Cycle order follows the insertion order of _I18N (the translated blocks).
  const ORDER = Object.keys(_I18N);
  const FALLBACK = ORDER.includes('en') ? 'en' : ORDER[0];

  function detect() {
    const s = localStorage.getItem('lang');
    if (s && _I18N[s]) return s;
    const nav = (navigator.language || '').toLowerCase().split('-')[0];
    return _I18N[nav] ? nav : FALLBACK;
  }

  let _lang = detect();

  function t(key, vars) {
    let str = (_I18N[_lang] && _I18N[_lang][key]) ||
              (_I18N[FALLBACK] && _I18N[FALLBACK][key]) || key;
    if (vars) Object.keys(vars).forEach(k => { str = str.replaceAll('{' + k + '}', vars[k]); });
    return str;
  }

  function nextLang() {
    const i = ORDER.indexOf(_lang);
    return ORDER[(i + 1) % ORDER.length];
  }

  function apply() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPh);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.dataset.i18nTitle);
    });
    const nxt = nextLang();
    document.querySelectorAll('.lang-toggle').forEach(btn => {
      btn.textContent = _LANG_LABELS[nxt] || nxt.toUpperCase();
      btn.title = t('nav.lang');
    });
    document.documentElement.lang = _lang;
  }

  window.t = t;
  window.setLang = function (lang) {
    if (!_I18N[lang]) return;
    _lang = lang;
    localStorage.setItem('lang', lang);
    apply();
    window.dispatchEvent(new CustomEvent('langchange'));
  };
  window.toggleLang = function () { window.setLang(nextLang()); };
  window.currentLang = function () { return _lang; };
  window.availableLangs = function () { return ORDER.slice(); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
