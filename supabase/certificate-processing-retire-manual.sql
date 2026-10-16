-- Apply AFTER backend + new admin portal pass live acceptance. No PDF rights
-- are removed from service_role; private browser INSERT and SELECT remain.
drop policy if exists "Training admin can insert certificate previews" on storage.objects;
alter policy "Training admin can insert versioned certificate PDFs" on storage.objects
 with check (
 bucket_id='credential-masters'
 and (select auth.uid()) is not null
 and lower((select auth.jwt()->>'email'))='johnathan@bulletproofautomations.com'
 and name ~ '^BPA-(FND|BCAB)-[0-9]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}/[0-9]{8}T[0-9]{6}-[0-9a-f]{8}[.]pdf$'
 and exists(select 1 from public.credentials c where c.credential_id=split_part(storage.objects.name,'/',1))
 );
