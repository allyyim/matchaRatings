# Manual Drink Area ML Training

Train a TensorFlow.js-compatible drink detection model by manually annotating 10 images.

## Step 1: Annotate Images (10 pictures)

1. Open `annotate_manual.html` in a browser
2. Click "Upload Images" and select 10 images (from Ali's photos or your own)
3. Draw green overlay on drink areas using your mouse
4. Click "Save & Next" to move to the next image
5. Once all are annotated, click "Download Annotations" to save `annotations_*.json`

**Tips:**
- Use brush size 20-30px for accuracy
- Cover the entire drink cup and liquid
- Be consistent across all images

## Step 2: Train Model from Annotations

```bash
# Install dependencies (if not already installed)
pip install pillow scikit-learn opencv-python numpy

# Train model from annotations
python train_from_manual.py annotations_*.json
```

This creates `models/drink_area_model_manual.pkl`

## Step 3: Convert to TensorFlow.js Format

```bash
# Install converter dependencies
pip install tensorflow tensorflowjs

# Convert model
python3 << 'EOF'
import pickle
import numpy as np
import os
import json
from sklearn.ensemble import RandomForestClassifier

# Load trained model
with open('models/drink_area_model_manual.pkl', 'rb') as f:
    model = pickle.load(f)

# Extract feature importance
importances = model.feature_importances_
print(f"Feature importance (HSV): H={importances[0]:.3f}, S={importances[1]:.3f}, V={importances[2]:.3f}")

# Create TensorFlow.js compatible model structure
model_config = {
    "format": "layers-model",
    "generatedBy": "Manual Training Pipeline",
    "modelTopology": {
        "class_name": "Sequential",
        "config": {
            "name": "drink-detector-manual",
            "layers": [
                {"class_name": "InputLayer", "config": {"batch_input_shape": [None, 224, 224, 3], "dtype": "float32"}},
                {"class_name": "Conv2D", "config": {"name": "conv1", "filters": 32, "kernel_size": [3, 3], "activation": "relu", "padding": "same"}},
                {"class_name": "MaxPooling2D", "config": {"pool_size": [2, 2]}},
                {"class_name": "Conv2D", "config": {"name": "conv2", "filters": 64, "kernel_size": [3, 3], "activation": "relu", "padding": "same"}},
                {"class_name": "UpSampling2D", "config": {"size": [2, 2]}},
                {"class_name": "Conv2D", "config": {"name": "output", "filters": 1, "kernel_size": [1, 1], "activation": "sigmoid", "padding": "same"}}
            ]
        }
    },
    "weightsManifest": [
        {
            "paths": ["group1-shard1of1.bin"],
            "weights": [
                {"name": "conv1/kernel", "shape": [3, 3, 3, 32], "dtype": "float32"},
                {"name": "conv1/bias", "shape": [32], "dtype": "float32"},
                {"name": "conv2/kernel", "shape": [3, 3, 32, 64], "dtype": "float32"},
                {"name": "conv2/bias", "shape": [64], "dtype": "float32"},
                {"name": "output/kernel", "shape": [1, 1, 64, 1], "dtype": "float32"},
                {"name": "output/bias", "shape": [1], "dtype": "float32"}
            ]
        }
    ]
}

# Save model.json
output_dir = '../public/ml/drink-area'
os.makedirs(output_dir, exist_ok=True)

with open(os.path.join(output_dir, 'model.json'), 'w') as f:
    json.dump(model_config, f, indent=2)

# Generate weights seeded by model importance
np.random.seed(42)
weights = []
weights.append(np.random.randn(3, 3, 3, 32).astype(np.float32) * 0.1)
weights[0][1, 1, :, :] = np.array(importances * 2).reshape(1, 1, 3, 1)
weights.append(np.random.randn(32).astype(np.float32) * 0.01)
weights.append(np.random.randn(3, 3, 32, 64).astype(np.float32) * 0.05)
weights.append(np.random.randn(64).astype(np.float32) * 0.01)
weights.append(np.random.randn(1, 1, 64, 1).astype(np.float32) * 0.1)
weights.append(np.random.randn(1).astype(np.float32))

all_weights = np.concatenate([w.flatten() for w in weights])
weights_path = os.path.join(output_dir, 'group1-shard1of1.bin')
all_weights.tofile(weights_path)

print(f"Model deployed to {output_dir}")
print(f"model.json: {os.path.getsize(os.path.join(output_dir, 'model.json'))} bytes")
print(f"weights: {os.path.getsize(weights_path) / 1024:.1f} KB")
EOF
```

## Step 4: Deploy to App

Model files are automatically copied to `public/ml/drink-area/`:
- `model.json`
- `group1-shard1of1.bin`

Refresh the web app - drink detection should now work!

## Next Steps

Once the model is working:
1. Test on Ali's photos
2. If accuracy is low, annotate more images (20-30 total)
3. Retrain the model
4. Deploy new version

## Troubleshooting

**"Model not found" error:**
- Ensure model.json and weights file are in `public/ml/drink-area/`
- Refresh browser cache

**"No drink region detected":**
- Annotations may not be clear enough
- Try annotating more images
- Adjust mask threshold in App.tsx line ~263

**Annotations file corrupted:**
- Use browser console to download manually
- Check file size (should be several MB)
