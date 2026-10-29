// E-mail « Confirme ton adresse » de Sillage (même mise en page que les autres e-mails), envoyé par Brevo.
const F = 'font-family:Arial,Helvetica,sans-serif;';
const SITE = 'https://sillage-ride.eu';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function shell(lang: string, pre: string, title: string, inner: string, foot: string) {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#F1F3F0">
<div style="display:none;max-height:0;overflow:hidden">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F3F0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
<tr><td style="padding:0 8px 20px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:10px"><img src="${SITE}/img/sillage-mail.png" width="40" height="40" alt="" style="display:block;border:0;border-radius:10px"></td>
<td style="${F}font-size:24px;font-weight:800;letter-spacing:-0.5px;color:#14201B">Sillage</td>
</tr></table></td></tr>
<tr><td bgcolor="#FFFFFF" style="border-radius:20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:32px 32px 8px;${F}font-size:24px;line-height:1.25;font-weight:800;color:#14201B">${title}</td></tr>
${inner}
</table></td></tr>
<tr><td style="padding:20px 8px 0;${F}font-size:12px;line-height:1.5;color:#4C5852">${foot}</td></tr>
</table></td></tr></table></body></html>`;
}
const p = (t: string, pad = '8px 32px 16px') => `<tr><td style="padding:${pad};${F}font-size:16px;line-height:1.55;color:#14201B">${t}</td></tr>`;
const btn = (label: string, url: string) => `<tr><td style="padding:8px 32px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#E0A21B" style="border-radius:999px"><a href="${url}" style="display:inline-block;padding:14px 26px;${F}font-size:16px;font-weight:bold;color:#14201B;text-decoration:none;border-radius:999px">${label}</a></td></tr></table></td></tr>`;
const small = (t: string) => `<tr><td style="padding:0 32px 28px;${F}font-size:13px;line-height:1.5;color:#4C5852">${t}</td></tr>`;

export function confirmLink(lang: string, token: string) {
  return lang === 'en' ? `${SITE}/en/account-confirmed/?t=${token}` : `${SITE}/compte-confirme/?t=${token}`;
}

export function confirmMail(lang: string, prenom: string, url: string) {
  if (lang === 'en') {
    return {
      subject: 'Confirm your e-mail address · Sillage',
      html: shell('en', 'One last step to activate your Sillage account.', prenom ? `Welcome ${esc(prenom)}!` : 'Welcome!',
        p('One last step: confirm your e-mail address to activate your Sillage account.') +
        btn('Confirm my address', url) +
        small(`The link is valid for 48 hours. If the button does not work, copy this address into your browser:<br><a href="${url}" style="color:#23629A;word-break:break-all">${url}</a>`) +
        small('You did not create a Sillage account? Just ignore this e-mail.'),
        `Sillage · Weather along your route.<br><a href="${SITE}/en/privacy/" style="color:#4C5852">Privacy</a> · <a href="mailto:hello@sillage-ride.eu" style="color:#4C5852">hello@sillage-ride.eu</a>`),
    };
  }
  return {
    subject: 'Confirme ton adresse e-mail · Sillage',
    html: shell('fr', 'Une dernière étape pour activer ton compte Sillage.', prenom ? `Bienvenue ${esc(prenom)} !` : 'Bienvenue !',
      p('Il reste une dernière étape : confirme ton adresse e-mail pour activer ton compte Sillage.') +
      btn('Confirmer mon adresse', url) +
      small(`Le lien est valable 48 heures. Si le bouton ne marche pas, copie cette adresse dans ton navigateur :<br><a href="${url}" style="color:#23629A;word-break:break-all">${url}</a>`) +
      small("Tu n'as pas créé de compte Sillage ? Ignore simplement cet e-mail."),
      `Sillage · La météo sur ta trace.<br><a href="${SITE}/confidentialite/" style="color:#4C5852">Confidentialité</a> · <a href="mailto:hello@sillage-ride.eu" style="color:#4C5852">hello@sillage-ride.eu</a>`),
  };
}
