export const NIFTI_FILE_ACCEPT = '.nii,.nii.gz,.gz,application/gzip,application/x-gzip,application/octet-stream'

export function isNiftiFileName(name: string): boolean {
  return /\.nii(?:\.gz)?$/i.test(name.trim())
}
