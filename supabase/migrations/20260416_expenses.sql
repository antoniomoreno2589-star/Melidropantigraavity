-- Gastos operativos persistidos por mes por usuario.
-- Cada registro es un concepto de gasto fijo o variable para un mes específico.
-- year_month: formato 'YYYY-MM' (ej. '2025-10').

CREATE TABLE IF NOT EXISTS expenses (
    id         BIGSERIAL   PRIMARY KEY,
    user_id    UUID        NOT NULL,
    year_month TEXT        NOT NULL,
    concept    TEXT        NOT NULL,
    amount     NUMERIC     NOT NULL DEFAULT 0,
    period     TEXT        NOT NULL DEFAULT 'Mensual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_month ON expenses (user_id, year_month);
