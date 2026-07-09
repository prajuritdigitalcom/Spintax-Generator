# AI Contextual Spintax Generator

Aplikasi pembuat spintax artikel berbasis AI Contextual Rewrite menggunakan Google Gemini API. Sistem ini mendukung rotasi otomatis banyak API Key (Multi-API Key Rotation) serta sistem failover cerdas agar proses rewrite berjalan lancar tanpa terganggu limit kuota atau rate limit.

## Panduan Deploy ke Vercel

Berikut adalah langkah-langkah mudah untuk men-deploy aplikasi ini ke Vercel secara langsung dari repositori GitHub Anda:

### Langkah 1: Persiapan Repositori GitHub
Pastikan seluruh file proyek saat ini sudah Anda push ke repositori GitHub Anda (termasuk file `package.json`, `server.ts`, dan file konfigurasi `vercel.json`).

### Langkah 2: Deploy Baru di Dashboard Vercel
1. Buka dan masuk ke akun Anda di [Vercel Dashboard](https://vercel.com/).
2. Klik tombol **Add New** -> **Project**.
3. Hubungkan akun GitHub Anda, pilih repositori proyek ini, lalu klik **Import**.

### Langkah 3: Konfigurasi Build & Development Settings
Secara default, Vercel akan mendeteksi setelan proyek Anda. Pastikan konfigurasi diatur seperti berikut:
* **Framework Preset**: Other / None (karena menggunakan custom build script)
* **Root Directory**: `.` (Root)
* **Build Command**: `npm run build`
* **Output Directory**: `dist`
* **Install Command**: `npm install`

### Langkah 4: Konfigurasi Environment Variables (Paling Penting!)
Di panel **Environment Variables** sebelum menekan deploy, masukkan kunci-kunci berikut sesuai kebutuhan Anda:

1. **`GEMINI_API_KEY`** (API Key Utama):
   * Key: `GEMINI_API_KEY`
   * Value: `AIzaSy...` (Kunci Gemini Anda)

2. **Multi-API Key Rotation (Opsional)**:
   Jika Anda ingin menggunakan fitur rotasi otomatis dan failover antar banyak API Key sekaligus, tambahkan kunci baru dengan format awalan `GEMINI_API_KEY_`:
   * Key: `GEMINI_API_KEY_1`, Value: `Kunci-Kedua`
   * Key: `GEMINI_API_KEY_2`, Value: `Kunci-Ketiga`
   * Key: `GEMINI_API_KEY_3`, Value: `Kunci-Keempat`
   * *(Dan seterusnya, jumlah kunci tidak dibatasi)*

3. **`GEMINI_MODEL`** (Opsional):
   * Key: `GEMINI_MODEL`
   * Value: `gemini-3.5-flash` (atau model Gemini terbaru pilihan Anda)

### Langkah 5: Deploy!
Setelah semua Environment Variables dimasukkan, klik tombol **Deploy**. Vercel akan memulai proses instalasi dependensi, melakukan build, dan memberikan URL aplikasi live Anda dalam waktu kurang dari 1-2 menit!

---

## Fitur Utama Aplikasi
* **Smart Contextual Rewrite**: Memahami makna kalimat secara utuh dibanding sekadar sinonim kata standar.
* **Smart Variation**: AI menentukan jumlah variasi spintax secara cerdas (2, 3, atau 4 variasi) menyesuaikan bobot kerumitan kalimat.
* **Keyword Protection**: Melindungi kata kunci penting agar tidak diubah atau diputar oleh AI.
* **Format & HTML Protection**: Mempertahankan tag HTML atau sintaks Markdown tetap utuh.
* **Automatic Failover & Cooldown**: Jika satu API Key mengalami rate limit, sistem otomatis mengalihkan beban ke kunci berikutnya dan mengistirahatkan kunci yang gagal selama 10 menit.
