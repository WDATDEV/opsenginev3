// Shrinks a camera photo on the device before upload, so a problem report stays small on a phone connection.

const MAX_SIDE = 1280;
const MAX_CHARS = 1_500_000;

function load(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file is not a photo."));
    };
    image.src = url;
  });
}

/** A JPEG data URL no wider or taller than 1280 px, and under about 1.5 MB. */
export async function shrinkPhoto(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("Choose a photo.");
  const image = await load(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the photo.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.75, 0.6, 0.45]) {
    const data = canvas.toDataURL("image/jpeg", quality);
    if (data.length <= MAX_CHARS) return data;
  }
  throw new Error("That photo is too large. Try again closer up.");
}
