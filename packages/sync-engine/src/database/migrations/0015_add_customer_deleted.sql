alter table "{{schema}}"."customers"
    add deleted boolean default false not null;