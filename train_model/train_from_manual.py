#!/usr/bin/env python3
"""
Train ML model from manually annotated images
"""
import json
import numpy as np
import cv2
import os
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
import pickle

def train_from_annotations(annotations_file):
    """Train model from manual annotations JSON"""

    if not os.path.exists(annotations_file):
        print(f"Error: {annotations_file} not found")
        return

    with open(annotations_file, 'r') as f:
        annotation_data = json.load(f)

    print(f"Loading {len(annotation_data['annotations'])} annotated images...")

    X_train = []
    y_train = []

    for filename, mask_png_b64 in annotation_data['annotations'].items():
        try:
            # Decode base64 PNG for mask
            import base64
            from io import BytesIO
            from PIL import Image

            # Extract data URL
            if ',' in mask_png_b64:
                _, data = mask_png_b64.split(',', 1)
            else:
                data = mask_png_b64

            img_bytes = base64.b64decode(data)
            mask_img = Image.open(BytesIO(img_bytes))
            mask_array = np.array(mask_img)
            h, w = mask_array.shape[:2]

            print(f"  Processing {filename}: {w}x{h} pixels, shape: {mask_array.shape}")

            # Detect drink pixels (where user drew green overlay)
            # The annotation has green overlay on drink areas (RGBA format)
            if len(mask_array.shape) == 3 and mask_array.shape[2] >= 3:
                # Check for green overlay
                r = mask_array[:, :, 0].astype(float)
                g = mask_array[:, :, 1].astype(float)
                b = mask_array[:, :, 2].astype(float)

                # Green pixels: high G, low R, low B (green > max(r,b))
                is_drink = (g > 100) & (g > r) & (g > b) & ((r + b) / 2 < 200)
            else:
                # Grayscale fallback
                is_drink = mask_array > 127

            print(f"    Drink area detected: {np.sum(is_drink)} pixels (checking G channel max: {np.max(mask_array[:,:,1]) if len(mask_array.shape) == 3 else 'N/A'})")

            # Create synthetic HSV training data based on annotations
            hsv_synthetic = np.zeros((h, w, 3), dtype=np.uint8)

            # Drink areas (where user drew)
            hsv_synthetic[is_drink, 1] = 120 + np.random.randint(0, 40, np.sum(is_drink))  # High saturation
            hsv_synthetic[is_drink, 2] = 100 + np.random.randint(0, 50, np.sum(is_drink))  # Medium value

            # Background (not annotated)
            bg_pixels = ~is_drink
            hsv_synthetic[bg_pixels, 1] = 30 + np.random.randint(0, 40, np.sum(bg_pixels))  # Low saturation
            hsv_synthetic[bg_pixels, 2] = 150 + np.random.randint(0, 50, np.sum(bg_pixels))  # High value (light)

            # Sample pixels
            step = max(1, h // 64)
            hsv_sampled = hsv_synthetic[::step, ::step].reshape(-1, 3)
            mask_sampled = is_drink[::step, ::step].flatten()

            X_train.append(hsv_sampled)
            y_train.append(mask_sampled)

            print(f"    Drink pixels: {np.sum(mask_sampled)} / {len(mask_sampled)}")

        except Exception as e:
            print(f"  Error processing {filename}: {str(e)}")

    if not X_train:
        print("No training data found!")
        return

    X_train_all = np.vstack(X_train)
    y_train_all = np.hstack(y_train)

    print(f"\nTraining on {X_train_all.shape[0]} pixels")
    print(f"Positive samples: {np.sum(y_train_all)} ({100*np.sum(y_train_all)/len(y_train_all):.1f}%)")

    # Train Random Forest
    print("\nTraining Random Forest classifier...")
    model = RandomForestClassifier(
        n_estimators=50,
        max_depth=20,
        random_state=42,
        n_jobs=-1,
        verbose=1
    )
    model.fit(X_train_all, y_train_all)

    # Save model
    os.makedirs('models', exist_ok=True)
    model_path = 'models/drink_area_model_manual.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump(model, f)

    print(f"\nModel saved to {model_path}")
    print(f"File size: {os.path.getsize(model_path) / 1024 / 1024:.1f} MB")

if __name__ == '__main__':
    import sys
    annotations_file = sys.argv[1] if len(sys.argv) > 1 else 'annotations.json'
    train_from_annotations(annotations_file)
