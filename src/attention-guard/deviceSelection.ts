import type { CameraDevice } from "./types";

/**
 * Only discard a saved camera when enumeration can actually prove it is gone.
 * Browsers may return cameras with empty device IDs before permission is
 * granted, and an empty list is not reliable evidence that a saved device is
 * permanently unavailable.
 */
export function isCameraSelectionConfirmedMissing(
  selectedDeviceId: string,
  devices: readonly CameraDevice[],
  devicesReady: boolean,
): boolean {
  if (!devicesReady || !selectedDeviceId) return false;
  if (devices.some((device) => device.deviceId === selectedDeviceId)) return false;
  return devices.length > 0 && devices.every((device) => Boolean(device.deviceId));
}
