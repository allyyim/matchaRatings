#!/usr/bin/env python3
"""
Train a U-Net model using TensorFlow from manual annotations
"""
import json
import numpy as np
import os
import base64
from io import BytesIO
from PIL import Image
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers

def train_model_tensorflow(annotations_file):
    """Train U-Net model on annotated images"""

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
            # Decode mask from base64 PNG
            if ',' in mask_png_b64:
                _, data = mask_png_b64.split(',', 1)
            else:
                data = mask_png_b64

            img_bytes = base64.b64decode(data)
            mask_img = Image.open(BytesIO(img_bytes))
            mask_array = np.array(mask_img)
            h, w = mask_array.shape[:2]

            print(f"  Processing {filename}: {w}x{h} pixels")

            # Detect drink pixels (green channel for annotated areas)
            if len(mask_array.shape) == 3:
                r = mask_array[:, :, 0].astype(float)
                g = mask_array[:, :, 1].astype(float)
                b = mask_array[:, :, 2].astype(float)
                is_drink = (g > 100) & (g > r) & (g > b)
            else:
                is_drink = mask_array > 127

            drink_pixels = np.sum(is_drink)
            print(f"    Drink pixels detected: {drink_pixels}")

            # Resize annotated image and create binary mask
            annotated_resized = Image.fromarray(mask_array).resize((224, 224), Image.LANCZOS)
            # Convert RGBA to RGB if needed
            if annotated_resized.mode == 'RGBA':
                annotated_resized = annotated_resized.convert('RGB')
            img_array = np.array(annotated_resized)

            # Create binary mask from resized image (1 where green, 0 elsewhere)
            if len(img_array.shape) == 3:
                r_resized = img_array[:, :, 0].astype(float)
                g_resized = img_array[:, :, 1].astype(float)
                b_resized = img_array[:, :, 2].astype(float)
                mask_array_resized = ((g_resized > 100) & (g_resized > r_resized) & (g_resized > b_resized)).astype(np.float32)
            else:
                mask_array_resized = (img_array > 127).astype(np.float32)

            X_train.append(img_array.astype(np.float32) / 255.0)
            y_train.append(np.expand_dims(mask_array_resized, axis=-1))

        except Exception as e:
            print(f"  Error processing {filename}: {str(e)}")

    if not X_train:
        print("No training data found!")
        return

    X_train = np.array(X_train)
    y_train = np.array(y_train)

    print(f"\nTraining data shape: {X_train.shape}, labels shape: {y_train.shape}")

    # Build U-Net model
    inputs = keras.Input(shape=(224, 224, 3))

    # Encoder
    c1 = layers.Conv2D(32, (3, 3), activation='relu', padding='same')(inputs)
    c1 = layers.Conv2D(32, (3, 3), activation='relu', padding='same')(c1)
    p1 = layers.MaxPooling2D((2, 2))(c1)

    c2 = layers.Conv2D(64, (3, 3), activation='relu', padding='same')(p1)
    c2 = layers.Conv2D(64, (3, 3), activation='relu', padding='same')(c2)
    p2 = layers.MaxPooling2D((2, 2))(c2)

    # Decoder
    u3 = layers.UpSampling2D((2, 2))(p2)
    u3 = layers.concatenate([u3, c2])
    c3 = layers.Conv2D(64, (3, 3), activation='relu', padding='same')(u3)
    c3 = layers.Conv2D(64, (3, 3), activation='relu', padding='same')(c3)

    u4 = layers.UpSampling2D((2, 2))(c3)
    u4 = layers.concatenate([u4, c1])
    c4 = layers.Conv2D(32, (3, 3), activation='relu', padding='same')(u4)
    c4 = layers.Conv2D(32, (3, 3), activation='relu', padding='same')(c4)

    # Output
    outputs = layers.Conv2D(1, (1, 1), activation='sigmoid')(c4)

    model = keras.Model(inputs=[inputs], outputs=[outputs])
    model.compile(optimizer='adam', loss='binary_crossentropy', metrics=['accuracy'])

    print("\nModel created. Training...")
    model.fit(X_train, y_train, epochs=20, batch_size=2, verbose=1)

    # Save H5 model
    os.makedirs('models', exist_ok=True)
    h5_path = 'models/drink_area_model.h5'
    model.save(h5_path)
    print(f"\nModel saved to {h5_path}")

    # Convert to TensorFlow.js using CLI
    output_dir = '../public/ml/drink-area'
    os.makedirs(output_dir, exist_ok=True)

    print(f"\nConverting to TensorFlow.js format...")
    import subprocess
    try:
        subprocess.run(['tensorflowjs_converter', '--input_format=keras', h5_path, output_dir], check=True)
        print(f"✓ Model deployed to {output_dir}")
        print(f"  - model.json")
        print(f"  - group1-shard1of1.bin")
    except Exception as e:
        print(f"Warning: tensorflowjs converter not available: {e}")
        print(f"Manual conversion required - run: tensorflowjs_converter --input_format=keras {h5_path} {output_dir}")

if __name__ == '__main__':
    import sys
    annotations_file = sys.argv[1] if len(sys.argv) > 1 else 'annotations.json'
    train_model_tensorflow(annotations_file)
