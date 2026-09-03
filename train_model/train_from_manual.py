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
            # Decode base64 PNG
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

            # Get original image (try to find it)
            if os.path.exists(f'data/ali_raw_images/{filename}'):
                img_path = f'data/ali_raw_images/{filename}'
            elif os.path.exists(filename):
                img_path = filename
            else:
                print(f"  Skipping {filename}: image file not found")
                continue

            img = cv2.imread(img_path)
            if img is None:
                print(f"  Skipping {filename}: couldn't read image")
                continue

            # Convert to HSV
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

            # Sample pixels (every nth to keep data manageable)
            h, w = hsv.shape[:2]
            step = max(1, h // 64)

            hsv_sampled = hsv[::step, ::step].reshape(-1, 3)
            mask_sampled = cv2.resize(mask_array, (w, h))
            mask_sampled = (mask_sampled > 127)[::step, ::step].flatten()

            X_train.append(hsv_sampled)
            y_train.append(mask_sampled)

            print(f"  Loaded {filename}: {np.sum(mask_sampled)} drink pixels")

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
