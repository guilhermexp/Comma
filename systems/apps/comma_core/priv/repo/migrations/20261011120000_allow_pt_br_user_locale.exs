defmodule Comma.Repo.Migrations.AllowPtBrUserLocale do
  use Ecto.Migration

  # Brazilian Portuguese joins the app languages. Stored languages are left as
  # they are; only the allowed set grows.
  def up do
    execute("SET LOCAL lock_timeout TO '5s'")

    drop(constraint(:comma_users, :comma_users_locale_check))

    create(
      constraint(:comma_users, :comma_users_locale_check,
        check: "locale IN ('en', 'zh-CN', 'pt-BR')"
      )
    )
  end

  # Fails while any account stores pt-BR; those rows must change first.
  def down do
    execute("SET LOCAL lock_timeout TO '5s'")

    drop(constraint(:comma_users, :comma_users_locale_check))

    create(
      constraint(:comma_users, :comma_users_locale_check, check: "locale IN ('en', 'zh-CN')")
    )
  end
end
