/**
 * Hands a text file to whatever the person wants to send it with (§10's Export data).
 *
 * On the phone the file is written to the app's cache and passed to Android's share
 * sheet; a WebView has no Web Share API. In the browser it is shared where the browser
 * can share files, and downloaded where it cannot — so the export is testable on a laptop.
 */

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './http';

export async function shareTextFile(name: string, text: string, mimeType: string): Promise<void> {
  if (isNative()) {
    const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: name, files: [uri] });
    return;
  }
  const file = new File([text], name, { type: mimeType });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
    return;
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
