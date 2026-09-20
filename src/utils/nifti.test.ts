import { describe, expect, it } from 'vitest'
import { isNiftiFileName, NIFTI_FILE_ACCEPT } from './nifti'

describe('NIfTI file selection', () => {
  it.each(['CT.nii.gz', 'ct.NII.GZ', 'scan.nii'])('accepts %s', name => {
    expect(isNiftiFileName(name)).toBe(true)
  })

  it.each(['CT.gz', 'scan.zip', 'scan.nii.gz.exe', ''])('rejects %s', name => {
    expect(isNiftiFileName(name)).toBe(false)
  })

  it('includes gzip MIME types used by Windows browsers', () => {
    expect(NIFTI_FILE_ACCEPT).toContain('application/gzip')
    expect(NIFTI_FILE_ACCEPT).toContain('.gz')
  })
})
