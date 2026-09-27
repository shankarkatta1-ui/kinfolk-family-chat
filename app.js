import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.KINFOLK_CONFIG || {};
const configured = config.supabaseUrl?.startsWith('https://') && config.publishableKey && !config.publishableKey.startsWith('YOUR_');
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let db, user, myMember, contacts = [], activeContact, messageChannel, authPhone = '';
let captchaToken='', captchaWidgetId, messagesLoaded=[], olderCursor=null, canLoadOlder=false, loadingOlder=false;

function show(id) { $('#configView').hidden = id !== 'configView'; $('#authView').hidden = id !== 'authView'; $('#appView').hidden = id !== 'appView'; }
function showToast(text) { const el=$('#toast'); el.textContent=text; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2400); }
function setAuthError(text='') { $('#authError').textContent=text; }
function phoneOK(phone) { return /^\+91[6-9]\d{9}$/.test(phone); }

async function requestCode(event) {
  event.preventDefault(); const phone=$('#phone').value.trim(); const name=$('#displayName').value.trim();
  setAuthError(''); if (!phoneOK(phone)) { setAuthError('Enter a 10-digit Indian mobile number with +91, such as +919876543210.'); return; }
  if(!captchaToken){setAuthError('Complete the anti-spam check first. If it does not appear, reload the app or contact the family owner.');return;}
  authPhone=phone; $('#sendCode').disabled=true;
  const {error}=await db.auth.signInWithOtp({phone, options:{shouldCreateUser:true,captchaToken}});
  captchaToken='';if(captchaWidgetId!==undefined)window.turnstile?.reset(captchaWidgetId);
  $('#sendCode').disabled=false;
  if(error){setAuthError(error.message);return;}
  $('#phoneForm').hidden=true; $('#otpForm').hidden=false; $('#authMessage').textContent=`Enter the code sent to ${phone}.`;
  $('#authTitle').textContent='Check your messages'; $('#otp').focus();
  if(name) sessionStorage.setItem('kinfolk-name',name);
}

async function verifyCode(event) {
  event.preventDefault(); setAuthError(''); const token=$('#otp').value.trim();
  const {data,error}=await db.auth.verifyOtp({phone:authPhone,token,type:'sms'});
  if(error){setAuthError(error.message);return;}
  user=data.user;
  const {data:member,error:memberError}=await db.from('family_members').select('id,family_id,auth_user_id,phone_e164,display_name,role,status').eq('auth_user_id',user.id).eq('status','active').maybeSingle();
  if(memberError){setAuthError(memberError.message);await db.auth.signOut();return;}
  if(member){await enterApp(member);return;}
  const {data:claimed,error:claimError}=await db.rpc('claim_family_invite',{p_display_name:sessionStorage.getItem('kinfolk-name')||''});
  if(claimError||!claimed){setAuthError('This phone number has not been added to the family yet. Ask a family member to add it, then try again.');await db.auth.signOut();return;}
  sessionStorage.removeItem('kinfolk-name'); await enterApp(claimed);
}

async function enterApp(member) {
  user=(await db.auth.getUser()).data.user; myMember=member; $('#userBadge').textContent=member.display_name;
  $('#signOut').hidden=false; show('appView');
  const {data:family}=await db.from('families').select('name').eq('id',member.family_id).maybeSingle();
  $('#familyName').textContent=family?.name||'Your Family';
  const {count}=await db.from('family_members').select('*',{count:'exact',head:true}).eq('family_id',member.family_id).eq('status','active');
  $('#memberCount').textContent=count||1; await loadContacts();
}

async function loadContacts() {
  const {data:links,error}=await db.from('contacts').select('id,contact_member_id').eq('owner_id',user.id).order('created_at');
  if(error){showToast(error.message);return;}
  const ids=(links||[]).map(link=>link.contact_member_id);
  if(!ids.length){contacts=[];activeContact=null;drawContacts();drawEmptyChat();return;}
  const {data:members,error:memberError}=await db.from('family_members').select('id,auth_user_id,phone_e164,display_name,status').in('id',ids);
  if(memberError){showToast(memberError.message);return;}
  contacts=(members||[]).map(member=>({...member,linkId:links.find(link=>link.contact_member_id===member.id)?.id}));
  if(activeContact) activeContact=contacts.find(contact=>contact.id===activeContact.id)||null;
  if(!activeContact) activeContact=contacts.find(contact=>contact.status==='active'&&contact.auth_user_id)||null;
  drawContacts(); if(activeContact) await openChat(activeContact); else drawEmptyChat();
}

function drawContacts(filter='') {
  const view=contacts.filter(contact=>contact.display_name.toLowerCase().includes(filter.toLowerCase())||contact.phone_e164.includes(filter));
  $('#contactCount').textContent=contacts.length;
  $('#people').innerHTML=view.map(contact=>`<div class="person ${activeContact?.id===contact.id?'active':''}" data-id="${contact.id}"><div class="avatar">${escapeHtml(contact.display_name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase())}</div><div class="person-info"><div class="person-name">${escapeHtml(contact.display_name)}</div><div class="person-sub">${contact.status==='active'&&contact.auth_user_id?'Family member':'Invited · waiting to join'}</div></div></div>`).join('')||'<div class="empty">No contacts yet.<br>Add someone by phone number.</div>';
  document.querySelectorAll('.person').forEach(row=>row.onclick=()=>{const contact=contacts.find(item=>item.id===row.dataset.id);if(contact?.status==='active'&&contact.auth_user_id){activeContact=contact;drawContacts($('#search').value);openChat(contact);}else showToast('They can chat after signing in with this invited number.');});
}

function drawEmptyChat() {
  if(messageChannel){db.removeChannel(messageChannel);messageChannel=null;}
  $('#chatAvatar').textContent='♥';$('#chatName').textContent='Your family chat';$('#chatStatus').textContent='Add a contact to start chatting';
  $('#messages').innerHTML='<div class="empty">Add a family member by phone number to start a private conversation.</div>';
  $('#messageInput').disabled=true;$('#sendMessage').disabled=true;
}

async function openChat(contact) {
  if(messageChannel){await db.removeChannel(messageChannel);messageChannel=null;}
  $('#chatAvatar').textContent=contact.display_name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
  $('#chatName').textContent=contact.display_name;$('#chatStatus').textContent='Family member · phone verified';
  $('#messageInput').disabled=false;$('#sendMessage').disabled=false;
  messagesLoaded=[];olderCursor=null;canLoadOlder=false;await loadMessages(contact,{reset:true});
  messageChannel=db.channel(`dm:${user.id}:${contact.auth_user_id}`).on('postgres_changes',{event:'INSERT',schema:'public',table:'messages'},payload=>{
    const row=payload.new;if([row.sender_id,row.recipient_id].includes(user.id)&&[row.sender_id,row.recipient_id].includes(contact.auth_user_id))loadMessages(contact);
  }).subscribe();
}

async function loadMessages(contact,{reset=false}={}) {
  const a=user.id,b=contact.auth_user_id;
  const {data,error}=await db.from('messages').select('id,sender_id,recipient_id,body,created_at').or(`and(sender_id.eq.${a},recipient_id.eq.${b}),and(sender_id.eq.${b},recipient_id.eq.${a})`).order('created_at',{ascending:false}).limit(100);
  if(error){showToast(error.message);return;}
  const recent=(data||[]).reverse();
  if(reset){messagesLoaded=recent;olderCursor=recent[0]?.created_at||null;canLoadOlder=(data||[]).length===100;}
  else {const ids=new Set(messagesLoaded.map(message=>message.id));messagesLoaded.push(...recent.filter(message=>!ids.has(message.id)));messagesLoaded.sort((left,right)=>left.created_at.localeCompare(right.created_at));}
  drawMessages(contact);
  if(reset)$('#messages').scrollTop=$('#messages').scrollHeight;
}

function drawMessages(contact){
  $('#messages').innerHTML=messagesLoaded.map(message=>`<div class="bubble-row ${message.sender_id===user.id?'mine':''}"><div class="bubble">${escapeHtml(message.body)}</div></div><div class="timestamp ${message.sender_id===user.id?'mine':''}">${new Date(message.created_at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</div>`).join('')||'<div class="empty">Say hello to '+escapeHtml(contact.display_name.split(' ')[0])+' 👋</div>';
}

async function loadOlderMessages(){
  if(loadingOlder||!canLoadOlder||!olderCursor||!activeContact)return;loadingOlder=true;
  const oldHeight=$('#messages').scrollHeight;const a=user.id,b=activeContact.auth_user_id;
  const {data,error}=await db.from('messages').select('id,sender_id,recipient_id,body,created_at').or(`and(sender_id.eq.${a},recipient_id.eq.${b}),and(sender_id.eq.${b},recipient_id.eq.${a})`).lt('created_at',olderCursor).order('created_at',{ascending:false}).limit(100);
  loadingOlder=false;if(error){showToast(error.message);return;}
  const older=(data||[]).reverse();if(older.length){const ids=new Set(messagesLoaded.map(message=>message.id));messagesLoaded=[...older.filter(message=>!ids.has(message.id)),...messagesLoaded];olderCursor=messagesLoaded[0].created_at;drawMessages(activeContact);$('#messages').scrollTop=$('#messages').scrollHeight-oldHeight;}
  if((data||[]).length<100)canLoadOlder=false;
}

async function sendMessage(event) {
  event.preventDefault();const input=$('#messageInput'),body=input.value.trim();if(!body||!activeContact?.auth_user_id)return;
  $('#sendMessage').disabled=true;
  const {error}=await db.from('messages').insert({sender_id:user.id,recipient_id:activeContact.auth_user_id,body});
  $('#sendMessage').disabled=false;
  if(error){showToast(error.message);return;}input.value='';await loadMessages(activeContact);
}

async function addContact(event) {
  event.preventDefault();$('#addError').textContent='';const phone=$('#newPhone').value.trim(),name=$('#newName').value.trim();
  if(!phoneOK(phone)){ $('#addError').textContent='Use a 10-digit Indian mobile number with +91, like +919876543210.';return; }
  const button=event.submitter;button.disabled=true;
  const {error}=await db.rpc('add_family_contact',{p_phone_e164:phone,p_display_name:name});
  button.disabled=false;if(error){$('#addError').textContent=error.message;return;}
  $('#addForm').reset();$('#modal').hidden=true;showToast('Family contact added. They can sign in with that phone number.');await loadContacts();
}

$('#phoneForm').addEventListener('submit',requestCode);$('#otpForm').addEventListener('submit',verifyCode);$('#composer').addEventListener('submit',sendMessage);$('#addForm').addEventListener('submit',addContact);
$('#changePhone').onclick=()=>{$('#otpForm').hidden=true;$('#phoneForm').hidden=false;$('#authTitle').textContent='Come on in';$('#authMessage').textContent='Sign in with the phone number a family member invited.';setAuthError('');};
$('#openAdd').onclick=()=>{$('#modal').hidden=false;$('#addError').textContent='';};$('#closeModal').onclick=()=>$('#modal').hidden=true;$('#modal').onclick=event=>{if(event.target===$('#modal'))$('#modal').hidden=true;};
$('#search').oninput=event=>drawContacts(event.target.value);$('#signOut').onclick=async()=>{if(messageChannel)await db.removeChannel(messageChannel);await db.auth.signOut();user=null;contacts=[];activeContact=null;$('#signOut').hidden=true;$('#userBadge').textContent='—';show('authView');};
$('#messages').addEventListener('scroll',()=>{if($('#messages').scrollTop<18)loadOlderMessages();});

if(!configured){show('configView');}
else {
  db=createClient(config.supabaseUrl,config.publishableKey);
  if(config.turnstileSiteKey&&!config.turnstileSiteKey.startsWith('YOUR_')&&window.turnstile){captchaWidgetId=window.turnstile.render('#captchaWidget',{sitekey:config.turnstileSiteKey,callback:token=>{captchaToken=token;},'expired-callback':()=>{captchaToken='';}});}
  show('authView');
  const {data:{session}}=await db.auth.getSession();
  if(session){user=session.user;const {data:member}=await db.from('family_members').select('id,family_id,auth_user_id,phone_e164,display_name,role,status').eq('auth_user_id',user.id).eq('status','active').maybeSingle();if(member)await enterApp(member);else await verifySignedIn();}
  db.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){myMember=null;contacts=[];activeContact=null;$('#signOut').hidden=true;show('authView');}});
}

async function verifySignedIn(){
  const {data:existing}=await db.from('family_members').select('id,family_id,auth_user_id,phone_e164,display_name,role,status').eq('auth_user_id',user.id).eq('status','active').maybeSingle();
  if(existing){await enterApp(existing);return;}
  const {data:member,error}=await db.rpc('claim_family_invite',{p_display_name:sessionStorage.getItem('kinfolk-name')||''});
  if(error||!member){setAuthError('This number is not invited into the family yet. Ask a family member to add it.');await db.auth.signOut();return;}
  sessionStorage.removeItem('kinfolk-name');await enterApp(member);
}

if('serviceWorker' in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
