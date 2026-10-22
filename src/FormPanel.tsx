import { useEffect, useState } from 'react'
import type { Field } from './types'

interface Props {
  fields: Field[]
  onApply: (values: Record<string, unknown>) => void
  onClose: () => void
}

export function FormPanel({ fields, onApply, onClose }: Props) {
  const [values, setValues] = useState<Record<string, unknown>>({})

  useEffect(() => {
    setValues(Object.fromEntries(fields.map((f) => [f.name, f.value ?? ''])))
  }, [fields])

  const supported = fields.filter((f) => ['Text', 'CheckBox', 'ComboBox', 'ListBox'].includes(f.type))

  return (
    <aside className="side form-panel">
      <header>
        <strong>Formulario</strong>
        <button className="link" onClick={onClose}>
          Cerrar
        </button>
      </header>
      {supported.length === 0 && <p className="muted">Este documento no tiene campos compatibles.</p>}
      <div className="fields">
        {supported.map((f) => (
          <label key={f.name + f.page}>
            <span>
              {f.name} <em>pág. {f.page + 1}</em>
            </span>
            {f.type === 'CheckBox' ? (
              <input
                type="checkbox"
                checked={values[f.name] === true || values[f.name] === 'Yes' || values[f.name] === 'On'}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })}
              />
            ) : f.choices && f.choices.length ? (
              <select value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}>
                <option value=""></option>
                {f.choices.map((c) => (
                  <option key={String(c)} value={String(c)}>
                    {String(c)}
                  </option>
                ))}
              </select>
            ) : (
              <input type="text" value={String(values[f.name] ?? '')} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
            )}
          </label>
        ))}
      </div>
      {supported.length > 0 && (
        <button className="primary" onClick={() => onApply(values)}>
          Aplicar campos
        </button>
      )}
    </aside>
  )
}
