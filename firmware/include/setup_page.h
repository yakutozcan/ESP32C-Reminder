#pragma once
#include <Arduino.h>

static const char SETUP_PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Masa · İlk kurulum</title>
  <style>
    body{font:18px/1.5 system-ui;background:#f7f4ed;color:#263d30;max-width:480px;margin:40px auto;padding:20px}
    label{display:block;margin:24px 0}input,select,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;border:1px solid #b9bdb5;border-radius:4px;background:#fff;color:#263d30}
    button[type=submit]{background:#263d30;color:#fff}button:disabled{opacity:.6;cursor:wait}
    code{overflow-wrap:anywhere}small{display:block;color:#526355}.check{display:flex;gap:10px;align-items:center}.check input{width:auto}
    [hidden]{display:none!important}:focus-visible{outline:2px solid #263d30;outline-offset:3px}
    #scan-status{font-size:15px;min-height:24px}h1{font-size:32px;line-height:1.2}
  </style>
</head>
<body>
  <h1>Masa'yı Wi-Fi'ye bağla.</h1>
  <p>Yakındaki 2,4 GHz ağlarını buluyoruz. Kendi ağını seç; kaydettikten sonra bilgisayarını o ağa geri bağla.</p>
  <form method="post" action="/save">
    <label id="network-label">Wi-Fi ağı
      <select name="ssid" id="networks" required><option value="">Ağlar taranıyor…</option></select>
    </label>
    <p id="scan-status" role="status" aria-live="polite">Yakındaki ağlar taranıyor…</p>
    <button type="button" id="refresh">Yeniden tara</button>
    <label class="check"><input type="checkbox" id="manual">Ağım gizli · adını kendim yazacağım</label>
    <label id="manual-label" hidden>Ağ adı (SSID)<input name="ssid" id="manual-ssid" required disabled maxlength="32" autocomplete="off"></label>
    <label id="password-label">Wi-Fi şifresi
      <input name="password" id="password" type="password" minlength="8" maxlength="64" autocomplete="new-password">
      <small id="password-help">Seçtiğin ağın şifresini gir. Şifresiz ağda bu alan kullanılmaz.</small>
    </label>
    <h2>Cihaz anahtarın</h2>
    <p>Masa uygulamasına daha önce kaydetmediysen bu anahtarı cihaz ayarlarına kopyala:</p>
    <code>__MASA_DEVICE_KEY__</code>
    <p>Cihaz adresi: <code>http://masa-reminder.local</code></p>
    <button type="submit">Wi-Fi'ye bağlan</button>
  </form>
  <script>
    const networks = document.querySelector('#networks');
    const manual = document.querySelector('#manual');
    const password = document.querySelector('#password');
    const status = document.querySelector('#scan-status');
    const refresh = document.querySelector('#refresh');
    function updatePassword() {
      const open = !manual.checked && networks.selectedOptions[0]?.dataset.secure === 'false';
      password.disabled = open;
      password.required = !manual.checked && !!networks.value && !open;
      document.querySelector('#password-label').hidden = open;
      document.querySelector('#password-help').textContent = manual.checked ? 'Şifresiz ağ için boş bırak.' : 'Seçtiğin ağın şifresini gir.';
    }
    manual.onchange = () => {
      networks.disabled = manual.checked;
      document.querySelector('#network-label').hidden = manual.checked;
      document.querySelector('#manual-label').hidden = !manual.checked;
      document.querySelector('#manual-ssid').disabled = !manual.checked;
      updatePassword();
    };
    networks.onchange = updatePassword;
    function showNetworks(items) {
      const selected = networks.value;
      networks.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = items.length ? 'Ağını seç' : 'Ağ bulunamadı';
      networks.append(placeholder);
      for (const network of items) {
        const option = document.createElement('option');
        option.value = network.ssid;
        const signal = network.rssi >= -60 ? 'güçlü' : network.rssi >= -75 ? 'orta' : 'zayıf';
        option.textContent = network.ssid + ' · ' + signal + ' · ' + (network.secure ? 'şifreli' : 'şifresiz');
        option.dataset.secure = String(network.secure);
        networks.append(option);
      }
      if (items.some(network => network.ssid === selected)) networks.value = selected;
      updatePassword();
      status.textContent = items.length ? items.length + ' ağ bulundu. Kendi ağını seç.' : 'Ağ bulunamadı. Yeniden tara veya ağ adını kendin yaz.';
    }
    async function scan() {
      refresh.disabled = true;
      networks.setAttribute('aria-busy', 'true');
      status.textContent = 'Yakındaki ağlar taranıyor…';
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          let result;
          try {
            const response = await fetch('/scan', {cache:'no-store', signal:controller.signal});
            if (!response.ok) throw new Error('scan');
            result = await response.json();
          } finally { clearTimeout(timeout); }
          if (Array.isArray(result)) {
            const distinct = new Map();
            for (const network of result) {
              if (!network.ssid) continue;
              const old = distinct.get(network.ssid);
              if (!old || network.rssi > old.rssi) distinct.set(network.ssid, network);
            }
            showNetworks([...distinct.values()].sort((a, b) => b.rssi - a.rssi)); return;
          }
          if (!result.scanning) throw new Error('scan');
          await new Promise(resolve => setTimeout(resolve, 700));
        }
        throw new Error('timeout');
      } catch {
        status.textContent = 'Tarama tamamlanamadı. Yeniden tara veya ağ adını kendin yaz.';
        if (!networks.value) networks.options[0].textContent = 'Tarama tamamlanamadı';
      } finally {
        refresh.disabled = false;
        networks.setAttribute('aria-busy', 'false');
      }
    }
    refresh.onclick = scan;
    scan();
  </script>
</body>
</html>)HTML";
