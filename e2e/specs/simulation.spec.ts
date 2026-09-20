import { expect, test } from '@playwright/test'
import { signInDoctor, useEnglish } from '../pages/demoPortal'

test('simulation loads manifest structures and creates a prediction-only opening', async ({ page }, testInfo) => {
  test.setTimeout(420_000)
  await page.setViewportSize({ width: 1440, height: 1200 })
  await useEnglish(page)
  await signInDoctor(page)
  await page.goto('/doctor/patients/P20260021/simulation')

  await expect(page.getByRole('heading', { name: '3D Human Interaction Simulation' })).toBeVisible()
  await expect(page.getByText('INDEPENDENT SIMULATION INPUT')).toBeVisible()
  await expect(page.getByText(/does not reuse, replace, or create a study on the Imaging page/)).toBeVisible()
  await expect(page.getByText(/requires the full stack/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upload and build simulation' })).toBeDisabled()
  await expect(page.getByText('LOCAL PREDICTION · NOT AUTHORITATIVE')).toBeVisible()
  await expect(page.getByText('Body / Skin', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Body \/ Skin body · KINEMATIC/ })).toBeVisible()
  await expect(page.getByText(/^(Liver|肝)$/)).toBeVisible()
  await expect(page.getByText('Cut depth', { exact: true })).toBeVisible()
  await expect(page.getByText('Loading simulation assets…')).toBeHidden({ timeout: 30_000 })
  await page.getByRole('button', { name: /Body \/ Skin body · KINEMATIC/ }).click()
  await page.getByRole('button', { name: 'Isolate selected structure' }).click()

  const canvas = page.locator('.simulation-canvas canvas')
  await expect(canvas).toBeVisible()
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Simulation canvas has no layout box')
  await testInfo.attach('loaded-case', {
    body: await canvas.screenshot(),
    contentType: 'image/png',
  })
  await page.mouse.click(box.x + box.width * 0.49, box.y + box.height * 0.38)
  await expect(page.getByText(/triangle \d+/).first()).toBeVisible()
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.61)
  await expect(page.getByRole('button', { name: 'Preview local opening' })).toBeEnabled()
  await page.getByRole('button', { name: 'Preview local opening' }).click()
  await expect(page.getByText(/Local opening prediction created/)).toBeVisible({ timeout: 120_000 })
  await expect(page.getByText('DISCONNECTED · topology v1')).toBeVisible()
  await testInfo.attach('predicted-opening', {
    body: await canvas.screenshot(),
    contentType: 'image/png',
  })

  // Hold one seam control away from the centre: the boundary must follow the
  // mapped mesh vertex and the surrounding skin must deform as one elastic
  // region rather than producing a single-vertex spike.
  await page.mouse.move(box.x + box.width * 0.47, box.y + box.height * 0.51)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.36, box.y + box.height * 0.51, { steps: 6 })
  await page.waitForTimeout(350)
  await testInfo.attach('dragged-elastic-opening', {
    body: await canvas.screenshot(),
    contentType: 'image/png',
  })
  await page.mouse.up()
  await page.waitForTimeout(400)
  await testInfo.attach('persistent-polygon-opening', {
    body: await canvas.screenshot(),
    contentType: 'image/png',
  })

  const openingSlider = page.getByLabel('Wound opening')
  await openingSlider.fill('80')
  await expect(openingSlider).toHaveValue('80')
  await testInfo.attach('regular-slider-opening', {
    body: await canvas.screenshot(),
    contentType: 'image/png',
  })

  // Intact skin remains cuttable after the first wound; cuts are not globally locked.
  // A missed control drag is intentionally handed to OrbitControls, so restore
  // the deterministic front view before selecting a second surface region.
  await page.getByRole('button', { name: 'Reset camera' }).click()
  await page.waitForTimeout(500)
  await canvas.scrollIntoViewIfNeeded()
  const recutBox = await canvas.boundingBox()
  if (!recutBox) throw new Error('Simulation canvas lost its layout box')
  await page.mouse.click(recutBox.x + recutBox.width * 0.57, recutBox.y + recutBox.height * 0.36)
  await expect(page.getByText('Select point B', { exact: true })).toBeVisible()
  await page.mouse.click(recutBox.x + recutBox.width * 0.57, recutBox.y + recutBox.height * 0.52)
  await expect(page.getByRole('button', { name: 'Preview local opening' })).toBeEnabled({ timeout: 120_000 })
})
