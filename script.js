// Star rating logic
const starRating = document.getElementById('star-rating');
let currentRating = 0;
for (let i = 1; i <= 5; i++) {
  const star = document.createElement('span');
  star.classList.add('star');
  star.innerHTML = '★';
  star.dataset.value = i;
  star.addEventListener('click', () => {
    currentRating = i;
    updateStars();
  });
  starRating.appendChild(star);
}
function updateStars() {
  document.querySelectorAll('.star').forEach(star => {
    star.classList.toggle('selected', parseInt(star.dataset.value) <= currentRating);
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
    let greenSum = 0, pixelCount = 0;
    for (let i = 0; i < imageData.length; i += 4) {
      const r = imageData[i];
      const g = imageData[i+1];
      const b = imageData[i+2];
      // Only count pixels that are not white-ish
      if (r < 240 || g < 240 || b < 240) {
        greenSum += g;
        pixelCount++;
      }
    }
  // Normalize greenness to a 0-10 scale (0 = not green, 10 = very green)
  // Green channel ranges 0-255, so map average green to 0-10
  const avgGreen = pixelCount ? (greenSum / pixelCount) : 0;
  matchaGreenness = Math.round((avgGreen / 255) * 10);
  greennessResult.textContent = `Greenness (out of 10): ${matchaGreenness}`;
  };
  img.src = dataUrl;
}

// Save rating and log
const saveBtn = document.getElementById('save-btn');
const ratingsLog = document.getElementById('ratings-log');
saveBtn.addEventListener('click', () => {
  if (!photoDataUrl || !currentRating || matchaGreenness === null) {
    alert('Please upload a photo, analyze greenness, and select a rating.');
    return;
  }
  const entry = {
    photo: photoDataUrl,
    rating: currentRating,
    greenness: matchaGreenness,
    date: new Date().toLocaleString()
  };
  saveEntry(entry);
  renderLog();
  resetForm();
});

function saveEntry(entry) {
  const log = JSON.parse(localStorage.getItem('matchaLog') || '[]');
  log.unshift(entry);
  localStorage.setItem('matchaLog', JSON.stringify(log));
}

function renderLog() {
  const log = JSON.parse(localStorage.getItem('matchaLog') || '[]');
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
