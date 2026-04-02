import { cn } from '@/lib/utils'

interface JsonSchemaFormProps {
  schema: Record<string, unknown>
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}

/**
 * Render form fields dynamically from a JSON Schema object.
 * Supports string, number, boolean, and nested object properties.
 */
export function JsonSchemaForm({ schema, values, onChange }: JsonSchemaFormProps) {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>
  const required = new Set((schema.required ?? []) as string[])

  function setValue(key: string, value: unknown) {
    onChange({ ...values, [key]: value })
  }

  return (
    <div className="flex flex-col gap-4">
      {Object.entries(properties).map(([key, prop]) => (
        <FieldInput
          key={key}
          name={key}
          prop={prop}
          value={values[key]}
          required={required.has(key)}
          onChange={(v) => setValue(key, v)}
        />
      ))}
    </div>
  )
}

interface SchemaProperty {
  type?: string | string[]
  description?: string
  default?: unknown
  enum?: unknown[]
  format?: string
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

function FieldInput({
  name,
  prop,
  value,
  required,
  onChange,
}: {
  name: string
  prop: SchemaProperty
  value: unknown
  required: boolean
  onChange: (v: unknown) => void
}) {
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type
  const label = formatLabel(name)

  // Skip the `type` discriminator field — it's set by the parent
  if (name === 'type') return null

  // Nested object
  if (type === 'object' && prop.properties) {
    return (
      <fieldset className="rounded-lg border border-gray-200 p-4">
        <legend className="px-1 text-sm font-medium text-gray-600">{label}</legend>
        <JsonSchemaForm
          schema={prop as Record<string, unknown>}
          values={(value as Record<string, unknown>) ?? {}}
          onChange={onChange}
        />
      </fieldset>
    )
  }

  // Enum → select
  if (prop.enum) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">
          {label}
          {required && <span className="text-red-500"> *</span>}
        </label>
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cn(fieldClass)}
        >
          <option value="">— select —</option>
          {prop.enum.map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
        {prop.description && <p className="text-xs text-gray-400">{prop.description}</p>}
      </div>
    )
  }

  // Boolean → checkbox
  if (type === 'boolean') {
    return (
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={Boolean(value ?? prop.default)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600"
        />
        <span className="text-sm font-medium text-gray-700">{label}</span>
        {prop.description && <span className="text-xs text-gray-400">{prop.description}</span>}
      </label>
    )
  }

  // Number / integer
  if (type === 'number' || type === 'integer') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">
          {label}
          {required && <span className="text-red-500"> *</span>}
        </label>
        <input
          type="number"
          value={value !== undefined ? String(value) : ''}
          placeholder={prop.default !== undefined ? String(prop.default) : undefined}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          className={cn(fieldClass)}
        />
        {prop.description && <p className="text-xs text-gray-400">{prop.description}</p>}
      </div>
    )
  }

  // String (default) — use textarea for long descriptions, password for secrets
  const isSecret =
    name.includes('key') ||
    name.includes('secret') ||
    name.includes('token') ||
    name.includes('password')
  const inputType = isSecret ? 'password' : prop.format === 'uri' ? 'url' : 'text'

  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-gray-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        type={inputType}
        value={(value as string) ?? ''}
        placeholder={prop.default !== undefined ? String(prop.default) : undefined}
        onChange={(e) => onChange(e.target.value || undefined)}
        className={cn(fieldClass)}
      />
      {prop.description && <p className="text-xs text-gray-400">{prop.description}</p>}
    </div>
  )
}

const fieldClass =
  'rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-300'

function formatLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
