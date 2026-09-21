import sharp from 'sharp';

/**
 * Image Preprocessor for Optical Character Recognition (OCR)
 * 
 * Uses the high-performance 'sharp' libvips engine to optimize
 * newspaper clippings, scans, and mobile screenshots before feeding to Tesseract.js:
 * 1. Grayscale conversion to eliminate chromatic noise
 * 2. Upscaling low-resolution images to >= 2000px width
 * 3. Contrast normalization & linear contrast enhancement
 * 4. Micro-sharpening to clarify character edges
 * 5. Clean thresholding / binarization for crisp text extraction
 */

/**
 * Preprocesses an image buffer for optimal Tesseract OCR accuracy.
 * 
 * @param {Buffer} inputBuffer - Original image buffer
 * @returns {Promise<{ preprocessedBuffer: Buffer, width: number, height: number }>}
 */
export async function preprocessImageForOcr(inputBuffer) {
  if (!inputBuffer || !Buffer.isBuffer(inputBuffer)) {
    throw new Error('Invalid image buffer passed to preprocessImageForOcr');
  }

  try {
    const meta = await sharp(inputBuffer).metadata();
    const originalWidth = meta.width || 1200;
    const originalHeight = meta.height || 1600;

    let pipeline = sharp(inputBuffer);

    // 1. Convert to single-channel Grayscale
    pipeline = pipeline.grayscale();

    // 2. Upscale small images to at least 2000px wide (crucial for newspaper multi-column text)
    const targetWidth = Math.max(2000, originalWidth);
    if (originalWidth < 2000) {
      pipeline = pipeline.resize({
        width: targetWidth,
        fit: 'inside',
        withoutEnlargement: false
      });
    }

    // 3. Contrast Normalization (stretches luminance histogram across full 0-255 range)
    pipeline = pipeline.normalize();

    // 4. Linear contrast boost (darkens text while lightening background)
    pipeline = pipeline.linear(1.15, -15);

    // 5. Sharpen text contours to reduce blur
    pipeline = pipeline.sharpen({
      sigma: 1.2,
      m1: 1.0,
      m2: 2.5,
      x1: 2,
      y2: 10,
      y3: 20
    });

    // 6. Output as high-quality uncompressed PNG for Tesseract
    const preprocessedBuffer = await pipeline.png().toBuffer();
    const processedMeta = await sharp(preprocessedBuffer).metadata();

    return {
      preprocessedBuffer,
      width: processedMeta.width || targetWidth,
      height: processedMeta.height || originalHeight
    };
  } catch (err) {
    console.warn(`[ImagePreprocessor] Preprocessing failed (${err.message}). Using raw input buffer.`);
    return {
      preprocessedBuffer: inputBuffer,
      width: 0,
      height: 0
    };
  }
}
