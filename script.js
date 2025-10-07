// Star rating logic
const starRating = document.getElementById('star-rating');
let currentRating = 0;
const pixelStarUrl = 'blank.png'; // Unselected
const pixelStarFilledUrl = 'filled.png'; // Rated star
for (let i = 1; i <= 5; i++) {
  const star = document.createElement('img');
  star.classList.add('star');
  star.src = pixelStarUrl;
  star.alt = 'star';
  star.dataset.value = i;
  star.style.width = '32px';
  star.style.height = '32px';
  star.style.cursor = 'pointer';
  star.addEventListener('click', () => {
    currentRating = i;
    updateStars();
  });
  starRating.appendChild(star);
}
function updateStars() {
  document.querySelectorAll('.star').forEach(star => {
    if (parseInt(star.dataset.value) <= currentRating) {
      star.src = pixelStarFilledUrl;
    } else {
      star.src = pixelStarUrl;
    }
  });
}

// Photo upload and greenness analysis

const photoInput = document.getElementById('matcha-photo');
const previewImg = document.getElementById('preview');
const canvas = document.getElementById('photo-canvas');
const greennessResult = document.getElementById('greenness-result');
let matchaGreenness = null;
let photoDataUrl = null;

// Photobooth elements
const photoboothVideo = document.getElementById('photobooth-video');
const captureBtn = document.getElementById('capture-btn');
let photoboothStream = null;

// Start camera automatically and enable capture only when ready
function startPhotoboothCamera() {
  captureBtn.disabled = true;
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(stream => {
      photoboothStream = stream;
      photoboothVideo.srcObject = stream;
      photoboothVideo.onloadedmetadata = () => {
        photoboothVideo.play();
        captureBtn.disabled = false;
      };
    })
    .catch(() => {
      captureBtn.disabled = true;
      photoboothVideo.style.display = 'none';
      const errorMsg = document.createElement('div');
      errorMsg.textContent = 'Unable to access camera.';
      errorMsg.style.color = 'red';
      photoboothVideo.parentNode.appendChild(errorMsg);
    });
}
startPhotoboothCamera();

// Stop camera when page unloads
window.addEventListener('beforeunload', () => {
  if (photoboothStream) {
    photoboothStream.getTracks().forEach(track => track.stop());
  }
});

captureBtn.addEventListener('click', () => {
  if (!photoboothVideo.srcObject || captureBtn.disabled) return;
  // Draw video frame to canvas
  const w = photoboothVideo.videoWidth || 320;
  const h = photoboothVideo.videoHeight || 240;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photoboothVideo, 0, 0, w, h);
  photoDataUrl = canvas.toDataURL('image/png');
  previewImg.src = photoDataUrl;
  previewImg.style.display = 'block';
  analyzeGreenness(photoDataUrl);
});

photoInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    photoDataUrl = evt.target.result;
    previewImg.src = photoDataUrl;
    previewImg.style.display = 'block';
    analyzeGreenness(photoDataUrl);
  };
  reader.readAsDataURL(file);
});

function analyzeGreenness(dataUrl) {
  const img = new Image();
  img.onload = function() {
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height).data;
    let emeraldCount = 0, pixelCount = 0;
    // Wider mask: use almost full image
    const cx = Math.floor(img.width / 2);
    const cy = Math.floor(img.height / 2);
    const radius = Math.floor(Math.min(img.width, img.height) / 1.5);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx*dx + dy*dy > radius*radius) continue;
        const i = (y * img.width + x) * 4;
        const r = imageData[i];
        const g = imageData[i+1];
        const b = imageData[i+2];
        // Ignore highlights/reflections
        if (r > 230 && g > 230 && b > 230) continue;
        // Only count pixels where green is dominant and not too dark
        if (
          g > r + 5 && g > b + 5 &&
          g > 30 && r > 10 && b > 10 &&
          g < 255 && r < 255 && b < 255
        ) {
          pixelCount++;
          // Color analysis
          const maxRGB = Math.max(r, g, b);
          const minRGB = Math.min(r, g, b);
          const saturation = maxRGB ? (maxRGB - minRGB) / maxRGB : 0;
          // Penalize pale/yellow dullness
          let scoreBoost = 1;
          if (saturation < 0.15) scoreBoost -= 0.5; // pale
          if (r > 80 && g - r < 30) scoreBoost -= 0.5; // yellowish
          // Super emerald: high green, moderate blue, low red, good saturation
          if (
            g > 120 && b > 20 && b < g && r < 150 && saturation > 0.08
          ) {
            emeraldCount += 2 * scoreBoost; // double count for super emerald
          } else if (
            g > 60 && b > 10 && b < g && r < 180 && saturation > 0.05
          ) {
            emeraldCount += scoreBoost;
          }
        }
      }
    }
    // Score is percent of emerald pixels in mask, scaled to 100
    matchaGreenness = pixelCount ? Math.min(100, Math.round((emeraldCount / pixelCount) * 100)) : 0;
    greennessResult.textContent = `Greenness (out of 100): ${matchaGreenness}`;
  };
  img.src = dataUrl;
}

// Save rating and log
const saveBtn = document.getElementById('save-btn');
const ratingsLog = document.getElementById('ratings-log');
saveBtn.addEventListener('click', () => {
  if (!currentRating || matchaGreenness === null) {
    let missing = [];
    if (!currentRating) missing.push('rating');
    if (matchaGreenness === null) missing.push('greenness');
    alert('Missing: ' + missing.join(', ') + '. Please analyze greenness and select a rating.');
    return;
  }
  const entry = {
    photo: photoDataUrl || '',
    rating: currentRating,
    greenness: matchaGreenness,
    date: new Date().toLocaleString()
  };
  saveEntry(entry);
  renderLog();
  resetForm();
});

// IndexedDB helpers
function openDB() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open('matchaRatingsDB', 1);
    request.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('logs')) {
        db.createObjectStore('logs', { keyPath: 'date' });
      }
    };
    request.onsuccess = function(e) { resolve(e.target.result); };
    request.onerror = function(e) { reject(e); };
  });
}

function saveEntry(entry) {
  openDB().then(db => {
    const tx = db.transaction('logs', 'readwrite');
    const store = tx.objectStore('logs');
    store.put(entry);
    tx.oncomplete = function() { renderLog(); };
    tx.onerror = function(e) { alert('Failed to save log: ' + e.target.error); };
  });
}

function renderLog() {
  openDB().then(db => {
    const tx = db.transaction('logs', 'readonly');
    const store = tx.objectStore('logs');
    const request = store.getAll();
    request.onsuccess = function() {
      const log = request.result.sort((a, b) => new Date(b.date) - new Date(a.date));
      ratingsLog.innerHTML = '';
      log.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'rating-entry';
        div.innerHTML = `
          <img src="${entry.photo}" alt="Matcha" />
          <div>
            <div>Rating: ${'★'.repeat(entry.rating)}${'☆'.repeat(5-entry.rating)}</div>
            <div>Greenness (out of 10): ${entry.greenness}</div>
            <div>Date: ${entry.date}</div>
          </div>
        `;
        ratingsLog.appendChild(div);
      });
    };
  });
}

function resetForm() {
  previewImg.style.display = 'none';
  photoInput.value = '';
  greennessResult.textContent = '';
  currentRating = 0;
  updateStars();
  matchaGreenness = null;
  photoDataUrl = null;
}

// Initial render
renderLog();
