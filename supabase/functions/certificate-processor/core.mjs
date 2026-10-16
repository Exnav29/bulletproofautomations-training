export const ID = /^BPA-(?:FND|BCAB|TRN)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
export const KEY = /^(BPA-(?:FND|BCAB|TRN)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6})\/\d{8}T\d{6}-[0-9a-f]{8}\.pdf$/;
export function validateJob(body) {
  if (!body || !ID.test(body.credential_id) || !['publish','restore','repair'].includes(body.mode) ||
      !KEY.test(body.master_path) || body.master_path.split('/')[0] !== body.credential_id ||
      !body.expected_updated_at || !Number.isFinite(Date.parse(body.expected_updated_at)) ||
      !(body.expected_pdf_path === null || (KEY.test(body.expected_pdf_path) && body.expected_pdf_path.split('/')[0] === body.credential_id))) {
    throw Error('Invalid credential, archive path, or version. Reload the register.');
  }
  if (body.mode === 'repair' && body.master_path !== body.expected_pdf_path) throw Error('Repair must use the currently published PDF.');
  return body;
}
export async function processJob(api, job, renderer, hash, validate) {
  const key = job.master_path, preview = key.slice(0,-4) + '.png';
  await api.stage(job, 'Retrieving private master');
  const pdf = await api.get('credential-masters', key);
  if (job.mode === 'repair') {
    const published = await api.get('credentials', key, true);
    if (await hash(published) !== await hash(pdf)) throw Error('Published PDF differs from private master; requires attention.');
  }
  await api.stage(job, 'Generating preview');
  // Always run the backend renderer for repair/backfill. It also proves an
  // existing preview is the actual conversion for this PDF + renderer version.
  const image = await renderer(pdf);
  validate(image.png, image.width, image.height);
  await api.stage(job, 'Saving archive');
  await api.ensure('credentials', key, pdf, 'application/pdf');
  await api.ensure('credentials', preview, image.png, 'image/png');
  // One transaction checks lease, expected version and both object metadata,
  // updates both paths together (preview only for repair), and completes job.
  return api.complete(job, { pdf_path: key, preview_path: preview, pdf_sha: image.pdfSha,
    png_sha: image.pngSha, width: image.width, height: image.height });
}
