# Hybrid drink-area model

Drop a TensorFlow.js model at `ml/drink-area/model.json` to let the app learn the drink region before applying the existing color score.

Expected behavior:
- Input: RGB image.
- Output: one mask tensor that squeezes to `[height, width]`.
- Mask values: `0.0` to `1.0`, where higher values mean "this pixel belongs to the drink area".

Recommended simple ML approach:
1. Label matcha drink areas on a few hundred photos.
2. Train a lightweight binary segmentation model.
3. Export it to TensorFlow.js format.
4. Put the exported files in `ml/drink-area/`.

If the model is missing or incompatible, the app falls back to the current heuristic circular mask.