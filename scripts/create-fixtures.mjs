import { writeFile, mkdir } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
const out = new URL('../artifacts/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.HelveticaBold);
for (const [i, size] of [[0, [612, 792]], [1, [792, 612]]]) {
 const page = pdf.addPage(size);
 page.drawRectangle({ x: 0, y: size[1] - 180, width: size[0], height: 180, color: rgb(.33,.30,.79) });
 page.drawText('SAMPLE DOCUMENT', { x: 48, y: size[1] - 72, size: 18, font, color: rgb(1,1,1) });
 page.drawText(`Page ${i + 1}`, { x: 48, y: size[1] - 126, size: 34, font, color: rgb(1,1,1) });
 page.drawText(i ? 'Landscape page' : 'Portrait page', { x: 48, y: size[1] - 240, size: 22, font, color: rgb(.2,.23,.19) });
 for (let j=0;j<7;j++) page.drawRectangle({x:48,y:size[1]-290-j*26,width:(j%3===0?280:410),height:7,color:rgb(.88,.89,.86)});
}
await writeFile(new URL('sample-document.pdf',out),await pdf.save());
const second = await PDFDocument.create();
const p=second.addPage([420,594]);p.drawText('SECOND DOCUMENT', {x:32,y:510,size:21,color:rgb(.13,.48,.38)});p.drawText('A smaller page stays small.',{x:32,y:460,size:15});
await writeFile(new URL('second-document.pdf',out),await second.save());
const form=await PDFDocument.create();const fp=form.addPage([400,400]);const f=form.getForm().createTextField('Name');f.setText('Example');f.addToPage(fp,{x:30,y:300,width:200,height:30});
await writeFile(new URL('interactive-form.pdf',out),await form.save());
const canvas=createCanvas(600,400),ctx=canvas.getContext('2d');
ctx.fillStyle='#f1e7cc';ctx.fillRect(0,0,600,400);ctx.fillStyle='#5750ca';ctx.fillRect(32,32,536,95);ctx.fillStyle='white';ctx.font='bold 34px sans-serif';ctx.fillText('A LANDSCAPE IMAGE',54,90);ctx.fillStyle='#cb6f45';ctx.fillRect(32,150,250,218);ctx.fillStyle='#277d68';ctx.beginPath();ctx.arc(423,258,105,0,Math.PI*2);ctx.fill();
await writeFile(new URL('sample-image.png',out),await canvas.encode('png'));
const jpeg=await canvas.encode('jpeg',95);
await writeFile(new URL('sample-photo.jpg',out),jpeg);
// EXIF orientation 6: the raw landscape pixels should display as a portrait image.
const exif=Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000','hex');
await writeFile(new URL('oriented-photo.jpg',out),Buffer.concat([jpeg.subarray(0,2),exif,jpeg.subarray(2)]));
await writeFile(new URL('unsupported.txt',out),'This is not a PDF or image.');
await writeFile(new URL('corrupt.pdf',out),'%PDF-1.7\ncorrupt');
console.log('Created synthetic browser-test fixtures.');
