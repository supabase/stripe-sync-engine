import { describe, it, expect } from 'vitest'
import { parseSchemaComment } from '../../supabase/schemaComment'

describe('parseSchemaComment', () => {
  describe('legacy plain-text format', () => {
    it('should parse "stripe-sync v1.0.19 installed"', () => {
      const result = parseSchemaComment('stripe-sync v1.0.19 installed')
      expect(result).toEqual({
        status: 'installed',
        oldVersion: undefined,
        newVersion: '1.0.19',
        errorMessage: undefined,
      })
    })

    it('should parse installing status installation:started', () => {
      const result = parseSchemaComment('stripe-sync v1.2.3 installation:started')
      expect(result).toEqual({
        status: 'installing',
        oldVersion: undefined,
        newVersion: '1.2.3',
        errorMessage: undefined,
      })
    })

    it('should parse install error status with error message', () => {
      const result = parseSchemaComment(
        'stripe-sync v1.2.3 installation:error - Database connection failed'
      )
      expect(result).toEqual({
        status: 'install error',
        oldVersion: undefined,
        newVersion: '1.2.3',
        errorMessage: 'Database connection failed',
      })
    })

    it('should parse uninstalling status uninstallation:started', () => {
      const result = parseSchemaComment('stripe-sync v1.2.3 uninstallation:started')
      expect(result).toEqual({
        status: 'uninstalling',
        oldVersion: undefined,
        newVersion: '1.2.3',
        errorMessage: undefined,
      })
    })

    it('should parse uninstall error status with error message', () => {
      const result = parseSchemaComment('stripe-sync v1.2.3 uninstallation:error - Cleanup failed')
      expect(result).toEqual({
        status: 'uninstall error',
        oldVersion: undefined,
        newVersion: '1.2.3',
        errorMessage: 'Cleanup failed',
      })
    })

    it('should return uninstalled for unknown legacy format', () => {
      const result = parseSchemaComment('stripe-sync v1.2.3 unknown-status')
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })

    it('should return uninstalled for comment without stripe-sync prefix', () => {
      const result = parseSchemaComment('some other comment')
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })
  })

  describe('JSON format', () => {
    it('should parse JSON comment with installed status', () => {
      const comment = JSON.stringify({
        status: 'installed',
        newVersion: '2.0.0',
      })
      const result = parseSchemaComment(comment)
      expect(result).toEqual({
        status: 'installed',
        newVersion: '2.0.0',
      })
    })

    it('should parse JSON comment with all fields', () => {
      const comment = JSON.stringify({
        status: 'install error',
        oldVersion: '1.0.0',
        newVersion: '2.0.0',
        errorMessage: 'Migration failed',
      })
      const result = parseSchemaComment(comment)
      expect(result).toEqual({
        status: 'install error',
        oldVersion: '1.0.0',
        newVersion: '2.0.0',
        errorMessage: 'Migration failed',
      })
    })

    it('should parse JSON comment with installing status', () => {
      const comment = JSON.stringify({
        status: 'installing',
        newVersion: '1.5.0',
      })
      const result = parseSchemaComment(comment)
      expect(result).toEqual({
        status: 'installing',
        newVersion: '1.5.0',
      })
    })

    it('should parse JSON comment with uninstalling status', () => {
      const comment = JSON.stringify({
        status: 'uninstalling',
        oldVersion: '1.2.3',
      })
      const result = parseSchemaComment(comment)
      expect(result).toEqual({
        status: 'uninstalling',
        oldVersion: '1.2.3',
      })
    })

    it('should fall back to legacy parsing for invalid JSON', () => {
      const result = parseSchemaComment('{ invalid json')
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })

    it('should fall back to legacy parsing for JSON without status field', () => {
      const comment = JSON.stringify({ version: '1.0.0' })
      const result = parseSchemaComment(comment)
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })
  })

  describe('edge cases', () => {
    it('should return uninstalled for null', () => {
      const result = parseSchemaComment(null)
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })

    it('should return uninstalled for undefined', () => {
      const result = parseSchemaComment(undefined)
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })

    it('should return uninstalled for empty string', () => {
      const result = parseSchemaComment('')
      expect(result).toEqual({
        status: 'uninstalled',
      })
    })
  })
})
