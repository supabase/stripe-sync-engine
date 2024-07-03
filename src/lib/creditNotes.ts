import Stripe from 'stripe'
import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { backfillInvoices } from './invoices'
import { backfillCustomers } from './customers'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import { stripe } from '../utils/StripeClientManager'
import { creditNoteSchema } from '../schemas/credit_note'

const config = getConfig()

export const upsertCreditNotes = async (
  creditNotes: Stripe.CreditNote[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.CreditNote[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(creditNotes, 'customer')),
      backfillInvoices(getUniqueIds(creditNotes, 'invoice')),
    ])
  }

  // Stripe only sends the first 10 refunds by default, the option will actively fetch all refunds
  if (getConfig().AUTO_EXPAND_LISTS) {
    for (const creditNote of creditNotes) {
      if (creditNote.lines?.has_more) {
        const allLines: Stripe.CreditNoteLineItem[] = []
        for await (const lineItem of stripe.creditNotes.listLineItems(creditNote.id, {
          limit: 100,
        })) {
          allLines.push(lineItem)
        }

        creditNote.lines = {
          ...creditNote.lines,
          data: allLines,
          has_more: false,
        }
      }
    }
  }

  return upsertMany(creditNotes, () =>
    constructUpsertSql(config.SCHEMA, 'credit_notes', creditNoteSchema)
  )
}

export const backfillCreditNotes = async (creditNoteIds: string[]) => {
  const missingCreditNoteIds = await findMissingEntries('credit_notes', creditNoteIds)
  await fetchAndInsertCreditNotes(missingCreditNoteIds)
}

const fetchAndInsertCreditNotes = async (creditNoteIds: string[]) => {
  if (!creditNoteIds.length) return

  const creditNotes: Stripe.CreditNote[] = []

  for (const creditNoteId of creditNoteIds) {
    const creditNote = await stripe.creditNotes.retrieve(creditNoteId)
    creditNotes.push(creditNote)
  }

  await upsertCreditNotes(creditNotes, true)
}
