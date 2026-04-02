import { test, expect } from '@playwright/test'

test('full pipeline creation flow: source → discover → streams → destination → review', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByText('Create Pipeline')).toBeVisible()

  // Step 1: Source — should show "stripe" in the dropdown
  const sourceSelect = page.locator('select').first()
  await expect(sourceSelect).toBeVisible()
  await sourceSelect.selectOption('stripe')

  // Fill in API key (required field)
  const apiKeyInput = page.locator('input[type="password"]').first()
  await expect(apiKeyInput).toBeVisible()
  await apiKeyInput.fill('sk_test_fake_for_discover')

  // Click "Next: Select streams" — triggers real discover against bundled OpenAPI spec
  await page.getByRole('button', { name: /next.*select streams/i }).click()

  // Step 2: Streams — should show grouped streams from the real Stripe catalog
  await expect(page.getByText('Select tables to sync')).toBeVisible({ timeout: 30_000 })

  // Verify we have real Stripe groups
  await expect(page.getByText('Payments')).toBeVisible()
  await expect(page.getByText('Billing')).toBeVisible()
  await expect(page.getByText('Customers')).toBeVisible()

  // Expand Payments and select a stream
  await page.getByText('Payments').click()
  const chargesCheckbox = page.locator('label').filter({ hasText: 'charges' }).locator('input')
  await chargesCheckbox.check()

  // Expand Customers and select
  await page.getByText('Customers').click()
  const customersCheckbox = page.locator('label').filter({ hasText: 'customers' }).locator('input')
  await customersCheckbox.check()

  // Verify search works
  const searchInput = page.getByPlaceholder('Find table')
  await searchInput.fill('invoice')
  await expect(page.getByText('Billing')).toBeVisible()
  await searchInput.clear()

  // Click next to destination
  await page.getByRole('button', { name: /next.*configure destination/i }).click()

  // Step 3: Destination — should show postgres and google-sheets
  await expect(page.locator('select').first()).toBeVisible()
  await page.locator('select').first().selectOption('postgres')

  // Click next to review
  await page.getByRole('button', { name: /next.*review/i }).click()

  // Step 4: Review — verify summary
  await expect(page.getByText('stripe').first()).toBeVisible()
  await expect(page.getByText('postgres').first()).toBeVisible()
  await expect(page.getByText('2 tables selected')).toBeVisible()
  await expect(page.getByText('charges')).toBeVisible()
  await expect(page.getByText('customers')).toBeVisible()

  // The "Start sync" button should be visible
  await expect(page.getByRole('button', { name: /start sync/i })).toBeVisible()
})
