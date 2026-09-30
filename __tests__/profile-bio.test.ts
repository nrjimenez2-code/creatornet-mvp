import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProfileBio from "@/components/ProfileBio";
import { activeBioMention, bioMentions, replaceBioMention, validateWebsite, websiteLabel } from "@/lib/profileBio";

test('bio parses case and punctuation without treating emails or embedded handles as mentions', () => {
  const text = '@Noah.Coach_1\n(@noah) hi@example.com first.last+tag@example.com /@skip a@skip @@skip @unknown';
  expect(bioMentions(text).map(m => m.username)).toEqual(['Noah.Coach_1','noah','unknown']);
  expect(bioMentions('@' + 'a'.repeat(21))).toEqual([]);
});
test('active token replacement preserves surrounding text and restores the cursor', () => {
  const text = 'Work with @no.ah_1 and @other';
  const cursor = text.indexOf('.ah');
  const token = activeBioMention(text, cursor)!;
  expect(token.username).toBe('no');
  expect(replaceBioMention(text, token, 'Noah.Coach')).toEqual({text:'Work with @Noah.Coach and @other',cursor:21});
  expect(activeBioMention(text, text.indexOf('@no')+1)).toBeNull();
  expect(activeBioMention('email@no',8)).toBeNull();
  expect(replaceBioMention('x'.repeat(590)+' @n', {start:591,end:593,username:'n'},'longusername')).toBeNull();
});
test('display escapes text, preserves line breaks, links valid case-insensitive mentions and leaves unknowns plain', () => {
  const html = renderToStaticMarkup(createElement(ProfileBio, {bio:'<script>bad</script>\n@NOAH.coach_1. and @gone',emptyMessage:'No bio yet.',websiteUrl:'https://example.com/path?secret=1#part',accounts:[{id:'account-1',username:'noah.coach_1',full_name:null,avatar_url:null}]}));
  expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;\n');
  expect(html).toContain('href="/creators/account-1"');
  expect(html).toContain('@NOAH.coach_1</a>. and @gone');
  expect(html).toContain('example.com/path</span>');
  expect(html).toContain('href="https://example.com/path?secret=1#part"');
  expect(html).toContain('target="_blank" rel="noopener noreferrer"');
});
test('empty bio retains the message and can show a website; unsafe stored links stay hidden', () => {
  const render = (websiteUrl:string) => renderToStaticMarkup(createElement(ProfileBio,{bio:null,emptyMessage:'Tell people about yourself.',websiteUrl,accounts:[]}));
  expect(render('example.com')).toContain('Tell people about yourself.');
  expect(render('example.com')).toContain('href="https://example.com/"');
  expect(render('javascript:alert(1)')).not.toContain('href=');
});
test('an ambiguous dotted handle stays plain while a separate valid shorter mention still links',()=>{
  const html=renderToStaticMarkup(createElement(ProfileBio,{bio:'@coach. and @coach',emptyMessage:'No bio yet.',accounts:[{id:'1',username:'coach',full_name:null,avatar_url:null}],ambiguousNames:['coach.']}));
  expect(html).toContain('@coach. and <a');expect(html.match(/href="\/creators\/1"/g)).toHaveLength(1);
});
test.each(['javascript:alert(1)','data:text/html,test','ftp://example.com','https://a:b@example.com','https://@example.com','https://example..com','https:///example.com','https://example.com\\evil','https://exa mple.com','not-a-domain','//example.com'])('rejects invalid website %s',input => expect(validateWebsite(input).error).not.toBeNull());
test.each([['example.com/path','https://example.com/path'],['HTTP://example.com/a?b=1#c','http://example.com/a?b=1#c'],['example.com:8080/a','https://example.com:8080/a']])('normalizes website %s', (input,url) => expect(validateWebsite(input)).toEqual({url,error:null}));
test('website clearing, length limits, and labels', () => {
  expect(validateWebsite('  ')).toEqual({url:null,error:null});
  expect(validateWebsite('https://example.com/'+ 'x'.repeat(2030)).error).not.toBeNull();
  expect(validateWebsite('example.com/'+ 'x'.repeat(2032)).error).not.toBeNull();
  expect(websiteLabel('https://example.com:8080/long/path?q=1#part')).toBe('example.com:8080/long/path');
});
