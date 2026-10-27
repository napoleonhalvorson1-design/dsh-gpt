"""Conservative n-way text merge: exact common-base line edits, no winner picking."""
from difflib import SequenceMatcher

MAX_BYTES=256*1024
MAX_LINES=4000
WORK_BUDGET=8_000_000

def merge_text(base,parents,budget):
 values=[base,*parents]
 if any(len(value)>MAX_BYTES for value in values):return None
 for value in values:
  try:value.decode('utf-8')
  except UnicodeDecodeError:return None
  if any(byte<32 and byte not in (9,10,13) or byte==127 for byte in value):return None
 lines=[value.splitlines(keepends=True) for value in values]
 if any(len(value)>MAX_LINES for value in lines):return None
 original=lines[0];cost=sum(len(original)*len(value) for value in lines[1:])
 if cost>budget['remaining']:return None
 budget['remaining']-=cost
 edits=[]
 for variant in lines[1:]:
  for tag,start,end,left,right in SequenceMatcher(None,original,variant,autojunk=False).get_opcodes():
   if tag=='equal':continue
   replacement=tuple(variant[left:right]);candidate=(start,end,replacement)
   if candidate in edits:continue
   for a,b,other in edits:
    # Insertions at an edited boundary are ambiguous; preserve a conflict.
    if max(start,a)<min(end,b) or start==end and a<=start<=b or a==b and start<=a<=end:return None
   edits.append(candidate)
 output=[];cursor=0
 for start,end,replacement in sorted(edits):
  output.extend(original[cursor:start]);output.extend(replacement);cursor=end
 output.extend(original[cursor:])
 return b''.join(output)
