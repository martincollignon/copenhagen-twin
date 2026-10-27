#!/usr/bin/env python3
"""Create calibrated silhouette overlays and a review sheet for Nyhavn views."""
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
from __future__ import annotations
import json, re, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT=Path.home()/".local/share/building-case-3d/nyhavn"
SKILL=OUT/"scripts"
sys.path.insert(0,str(SKILL))
from skraafoto import world_to_pixel

MODEL=json.loads((OUT/"model/building.json").read_text())
PHOTOS=OUT/"sources/skraafoto"
VALIDATION=OUT/"validation"
VALIDATION.mkdir(parents=True,exist_ok=True)

def main():
    panels=[]
    for cam in MODEL["cameras"]:
        image=Image.open(PHOTOS/cam["file"]).convert("RGB")
        draw=ImageDraw.Draw(image,"RGBA")
        crop=cam["crop"];factor=float(crop.get("overview_factor",1))
        def project(e,n,z):
            col,row=world_to_pixel(cam["pers"],e,n,z)
            return ((col-crop["x0"])/factor,(row-crop["y0"])/factor)
        for b in MODEL["buildings"]:
            ring=b["footprint_epsg25832"]
            tops=b["eave_boundary_dvr90"]
            ground=b["ground_dvr90"]
            bottom=[project(e,n,ground) for e,n in ring]
            roof=[project(e,n,tops[i]) for i,(e,n) in enumerate(ring)]
            if len(bottom)<2 or len(roof)!=len(bottom):continue
            draw.line(bottom+[bottom[0]],fill=(245,238,224,190),width=2,joint="curve")
            draw.line(roof+[roof[0]],fill=(204,85,68,235),width=3,joint="curve")
            for p,q in zip(bottom,roof):
                draw.line([p,q],fill=(204,85,68,160),width=1)
        label=f"{cam['direction']} · {cam['datetime']} · {cam['effective_gsd_m_px']:.2f} m/px"
        draw.rectangle((0,0,min(image.width,820),40),fill=(35,38,37,220))
        draw.text((12,11),label,fill=(250,247,239,255))
        safe=re.sub(r"[^A-Za-z0-9_.-]+","_",cam["view_id"])
        path=VALIDATION/f"overlay_{safe}.jpg"
        image.save(path,quality=91)
        scale=min(640/image.width,390/image.height)
        preview=image.resize((round(image.width*scale),round(image.height*scale)),Image.Resampling.LANCZOS)
        panels.append((label,preview))
        print(path.name)
    cell_w,cell_h=660,430
    cols=2;rows=(len(panels)+cols-1)//cols
    sheet=Image.new("RGB",(cols*cell_w,rows*cell_h),(235,233,226))
    sd=ImageDraw.Draw(sheet)
    for i,(label,img) in enumerate(panels):
        x=(i%cols)*cell_w;y=(i//cols)*cell_h
        sd.text((x+12,y+8),label,fill=(42,43,40))
        sheet.paste(img,(x+10,y+30))
    sheet.save(VALIDATION/"camera-overlay-review.jpg",quality=90)
    print("validation/camera-overlay-review.jpg")

if __name__=="__main__":main()
