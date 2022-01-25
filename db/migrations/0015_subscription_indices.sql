create index if not exists subscriptions_project_id ON stripe.subscriptions (((metadata ->> 'project_id')::int));
create index if not exists subscriptions_project_ref ON stripe.subscriptions ((metadata ->> 'project_ref'));
